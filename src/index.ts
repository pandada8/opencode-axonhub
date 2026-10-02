/**
 * @pandada8/opencode-axonhub — opencode v2 (promise API) plugin.
 *
 * Discovers AxonHub models from `/v1/models` and `/v1/models?include=all`, merges
 * both responses, and exposes them under a single `axonhub` provider by writing
 * them into the v2 catalog via `setup(ctx)` -> `ctx.provider.transform(...)`.
 *
 * Routing: each model is associated with the vendor protocol AxonHub expects
 * through its per-model `package` (@ai-sdk module) and `settings.baseURL`:
 *   - OpenAI models   -> `@ai-sdk/openai`   against `/v1`
 *   - Gemini/Google   -> `@ai-sdk/google`   against `/gemini/v1beta`
 *   - everything else -> `@ai-sdk/anthropic` against `/anthropic/v1`
 *
 * Optional enrichment (default on, toggle with `enrichModels: false`) pulls
 * richer metadata (`family`, `cost`, `limit`, modalities, headers, and
 * `experimental.modes` as v2 `variants` e.g. `gpt-5.5#fast`) from OpenCode's
 * default model cache at `~/.cache/opencode/models.json`.
 */

import type { Model, Provider, Plugin } from "@opencode/plugin"

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const PROVIDER_ID = "axonhub" as Provider.ID
const CACHE_FILE = join(homedir(), ".cache", "opencode", "axonhub-models.json")
const OPENCODE_MODELS_FILE = join(homedir(), ".cache", "opencode", "models.json")
const CACHE_TTL = 24 * 60 * 60 * 1000

const NPM = {
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai",
  google: "@ai-sdk/google",
} as const

type Options = { baseURL?: string; baseUrl?: string; apiKey?: string; api_key?: string; enrichModels?: boolean }

type Cost = Model.Info["cost"][number]
type Variant = Model.Info["variants"][number]
type ModelInfo = Model.Info
type ProviderInfo = Provider.Info

type SetupContext = Pick<Plugin.Context, "options" | "provider" | "integration">

type AxonHubModel = {
  id?: string
  name?: string
  owned_by?: string
  context_length?: number
  max_output_tokens?: number
  capabilities?: { vision?: boolean; tool_call?: boolean; reasoning?: boolean }
}

type AxonHubModelsResponse = { data?: AxonHubModel[] }

// Enrichment cache (v1 model.json) shapes.
type CacheCost = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  context_over_200k?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}
type CacheMode = { cost?: CacheCost; provider?: { body?: Record<string, unknown>; headers?: Record<string, string> } }
type CacheModel = {
  id?: string
  family?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  temperature?: boolean
  modalities?: { input?: string[]; output?: string[] }
  release_date?: string
  limit?: { context?: number; input?: number; output?: number }
  cost?: CacheCost
  provider?: { npm?: string }
  headers?: Record<string, string>
  options?: Record<string, unknown>
  experimental?: { modes?: Record<string, CacheMode> }
}
type CacheMatch = { providerID: string; model: CacheModel }

function normalizeBaseURL(baseURL: string) {
  return baseURL.replace(/\/v1\/?$/, "").replace(/\/+$/, "")
}

function modelPackage(owner: string | undefined, modelID: string | undefined) {
  if (modelID?.startsWith("gemini-") || owner === "google" || owner === "gemini") return `aisdk:${NPM.google}` as const
  if (owner === "openai" || owner === "codex") return `aisdk:${NPM.openai}` as const
  return `aisdk:${NPM.anthropic}` as const
}

function modelBaseURL(baseURL: string, owner: string | undefined, modelID: string | undefined) {
  const clean = normalizeBaseURL(baseURL)
  // The native Google provider appends `/models/{id}:streamGenerateContent`, so the base includes `/v1beta`.
  if (modelID?.startsWith("gemini-") || owner === "google" || owner === "gemini") return `${clean}/gemini/v1beta`
  if (owner === "openai" || owner === "codex") return `${clean}/v1`
  return `${clean}/anthropic/v1`
}

function costToV2(cost: CacheCost | undefined): Cost[] {
  if (!cost) return []
  const tiers: Cost[] = [
    { input: (cost.input ?? 0) as Cost["input"], output: (cost.output ?? 0) as Cost["input"], cache: { read: (cost.cache_read ?? 0) as Cost["input"], write: (cost.cache_write ?? 0) as Cost["input"] } },
  ]
  if (cost.context_over_200k) {
    tiers.push({
      tier: { type: "context", size: 200_000 },
      input: (cost.context_over_200k.input ?? 0) as Cost["input"],
      output: (cost.context_over_200k.output ?? 0) as Cost["input"],
      cache: { read: (cost.context_over_200k.cache_read ?? 0) as Cost["input"], write: (cost.context_over_200k.cache_write ?? 0) as Cost["input"] },
    })
  }
  return tiers
}

function modesToVariants(modes: Record<string, CacheMode> | undefined): Variant[] {
  if (!modes) return []
  return Object.entries(modes).map(([id, mode]) => ({
    id: id as Model.VariantID,
    ...(mode.provider?.body ? { body: mode.provider.body } : {}),
    ...(mode.provider?.headers ? { headers: mode.provider.headers } : {}),
  }))
}

function matchModel(item: AxonHubModel, index: Map<string, CacheMatch[]>, enrich: boolean): CacheModel | undefined {
  if (!enrich || !item.id) return
  const candidates = index.get(item.id)
  if (!candidates?.length) return
  const owner = item.owned_by
  return (
    (owner ? candidates.find((c) => c.providerID === owner) : undefined) ??
    candidates.find((c) => c.providerID === "openai") ??
    candidates.find((c) => c.providerID === "opencode") ??
    candidates[0]
  )?.model
}

function toModelInfo(
  baseURL: string,
  apiKey: string | undefined,
  item: AxonHubModel,
  match?: CacheModel,
  enrich = true,
): ModelInfo | undefined {
  if (!item.id) return
  const owner = item.owned_by
  const pkg = modelPackage(owner, item.id)
  const modalities = match?.modalities
  const attachment = item.capabilities?.vision ?? match?.attachment
  const input = modalities?.input?.length
    ? modalities.input
    : item.capabilities?.vision
      ? ["text", "image"]
      : ["text"]
  const output = modalities?.output?.length ? modalities.output : ["text"]

  const modes = enrich ? match?.experimental?.modes : undefined
  const variants = modesToVariants(modes)
  // AxonHub's Gemini gateway accepts `Authorization: Bearer` (not x-goog-api-key),
  // so carry the key as a Bearer header for the Google/`@ai-sdk/google` route.
  const headers =
    pkg === `aisdk:${NPM.google}` && apiKey
      ? { ...(match?.headers ?? {}), Authorization: `Bearer ${apiKey}` }
      : (match?.headers ?? {})

  return {
    id: item.id as Model.ID,
    modelID: item.id as Model.ID,
    providerID: PROVIDER_ID,
    name: item.name ?? match?.id ?? item.id,
    family: match?.family as Model.Info["family"],
    package: pkg,
    // Merge enrichment options (settings) with the per-model endpoint + key so routing always wins.
    settings: { ...(match?.options ?? {}), baseURL: modelBaseURL(baseURL, owner, item.id), ...(apiKey ? { apiKey } : {}) },
    headers,
    capabilities: { tools: item.capabilities?.tool_call ?? match?.tool_call ?? true, input, output },
    variants,
    time: { released: 0 },
    cost: costToV2(match?.cost),
    status: "active",
    enabled: true,
    limit: {
      context: item.context_length ?? match?.limit?.context ?? 200_000,
      input: match?.limit?.input,
      output: item.max_output_tokens ?? match?.limit?.output ?? 32_000,
    },
  }
}

async function readFreshCache(): Promise<AxonHubModelsResponse | undefined> {
  try {
    const info = await stat(CACHE_FILE)
    if (Date.now() - info.mtimeMs > CACHE_TTL) return
    return JSON.parse(await readFile(CACHE_FILE, "utf8")) as AxonHubModelsResponse
  } catch {
    return
  }
}

async function writeCache(payload: AxonHubModelsResponse) {
  try {
    await mkdir(dirname(CACHE_FILE), { recursive: true })
    await writeFile(CACHE_FILE, JSON.stringify(payload, null, 2))
  } catch {}
}

async function fetchAxonHubModels(baseURL: string, apiKey: string): Promise<AxonHubModel[]> {
  const clean = normalizeBaseURL(baseURL)
  const headers = { Authorization: `Bearer ${apiKey}` }
  const [basic, detailed] = await Promise.all([
    fetch(`${clean}/v1/models`, { headers }),
    fetch(`${clean}/v1/models?include=all`, { headers }),
  ])
  const payloads: AxonHubModel[] = []
  for (const response of [basic, detailed]) {
    if (!response.ok) continue
    const payload = (await response.json()) as AxonHubModelsResponse
    if (Array.isArray(payload.data)) payloads.push(...payload.data)
  }
  const byID = new Map<string, AxonHubModel>()
  for (const model of payloads) {
    if (!model.id) continue
    byID.set(model.id, { ...byID.get(model.id), ...model })
  }
  return [...byID.values()]
}

async function loadModels(baseURL: string, apiKey: string): Promise<AxonHubModel[]> {
  const cached = await readFreshCache()
  if (cached?.data?.length) return cached.data
  const payload = { data: await fetchAxonHubModels(baseURL, apiKey) }
  await writeCache(payload)
  return payload.data
}

async function readEnrichmentIndex(): Promise<Map<string, CacheMatch[]>> {
  try {
    const providers = JSON.parse(await readFile(OPENCODE_MODELS_FILE, "utf8")) as Record<string, { models?: Record<string, CacheModel> }>
    const index = new Map<string, CacheMatch[]>()
    for (const [providerID, provider] of Object.entries(providers)) {
      for (const [key, model] of Object.entries(provider.models ?? {})) {
        const match = { providerID, model }
        for (const id of new Set([key, model.id].filter((v): v is string => typeof v === "string"))) {
          const existing = index.get(id)
          if (existing) existing.push(match)
          else index.set(id, [match])
        }
      }
    }
    return index
  } catch {
    return new Map()
  }
}

export default {
  id: "opencode-axonhub",
  async setup(ctx: SetupContext): Promise<void> {
    try {
      const opts = (ctx?.options ?? {}) as Options
      const enrich = opts.enrichModels !== false
      // Resolve baseURL / apiKey: plugin options -> configured provider settings -> env
      let baseURL = opts.baseURL ?? opts.baseUrl
      let apiKey = opts.apiKey ?? opts.api_key

      if (!baseURL || !apiKey) {
        // Transforms run later during catalog processing; use the read API here.
        // An unconfigured provider may be absent, so still allow env fallback.
        const configured = await ctx.provider.get({ providerID: PROVIDER_ID }).catch(() => undefined)
        const settings = configured?.data.settings
        if (typeof settings?.baseURL === "string") baseURL ??= settings.baseURL
        if (typeof settings?.apiKey === "string") apiKey ??= settings.apiKey
      }
      baseURL ??= process.env.AXONHUB_BASE_URL
      apiKey ??= process.env.AXONHUB_API_KEY
      if (!baseURL || !apiKey) return

      const [items, index] = await Promise.all([loadModels(String(baseURL), String(apiKey)), readEnrichmentIndex()])
      const models: ModelInfo[] = []
      for (const item of items) {
        const match = matchModel(item, index, enrich)
        const model = toModelInfo(String(baseURL), apiKey, item, match, enrich)
        if (model) models.push(model)
      }

      const info: ProviderInfo = {
        id: PROVIDER_ID,
        name: "AxonHub",
        activation: "auto",
        package: "aisdk:@ai-sdk/openai",
        settings: { baseURL: normalizeBaseURL(String(baseURL)), ...(apiKey ? { apiKey } : {}) },
        headers: {},
        body: undefined,
      }

      // Register the API-key sign-in method (best-effort).
      ctx?.integration?.transform?.((ed) => {
        ed.update(PROVIDER_ID, (i) => (i.name = "AxonHub"))
        ed.method.update({ integrationID: PROVIDER_ID, method: { type: "key", label: "API Key" } })
      })

      // Write the provider and its discovered models into the catalog.
      ctx?.provider?.transform?.((ed) => {
        ed.add({ info, models })
      })
      await ctx?.provider?.reload?.().catch?.(() => {})
    } catch (error) {
      console.error("[opencode-axonhub] plugin setup failed", error)
    }
  },
}