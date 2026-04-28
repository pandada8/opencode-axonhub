import type { Config, Hooks, Plugin, ProviderContext } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const PROVIDER_ID = "axonhub"
const CACHE_FILE = join(homedir(), ".cache", "opencode", "axonhub-models.json")
const OPENCODE_MODELS_FILE = join(homedir(), ".cache", "opencode", "models.json")
const CACHE_TTL = 24 * 60 * 60 * 1000

const NPM_PACKAGES = {
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai",
} as const

type PluginOptions = {
  baseURL?: string
  apiKey?: string
  enrichModels?: boolean
}

type AxonHubModel = {
  id?: string
  name?: string
  display_name?: string
  created?: number
  created_at?: string
  owned_by?: string
  context_length?: number
  max_output_tokens?: number
  capabilities?: {
    vision?: boolean
    tool_call?: boolean
    toolCall?: boolean
    reasoning?: boolean
  }
  pricing?: {
    input?: number
    output?: number
    cache_read?: number
    cacheRead?: number
    cache_write?: number
    cacheWrite?: number
  }
}

type AxonHubModelsResponse = {
  data?: AxonHubModel[]
}

type OpenCodeModel = {
  id?: string
  name?: string
  family?: string
  release_date?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  interleaved?: true | { field: "reasoning_content" | "reasoning_details" }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
    context_over_200k?: {
      input?: number
      output?: number
      cache_read?: number
      cache_write?: number
    }
  }
  limit?: {
    context?: number
    input?: number
    output?: number
  }
  modalities?: {
    input?: string[]
    output?: string[]
  }
  experimental?: {
    modes?: Record<
      string,
      {
        cost?: OpenCodeModel["cost"]
        provider?: {
          body?: Record<string, unknown>
          headers?: Record<string, string>
        }
      }
    >
  }
  status?: "alpha" | "beta" | "deprecated" | "active"
  provider?: {
    npm?: string
    api?: string
  }
  options?: Record<string, unknown>
  headers?: Record<string, string>
  variants?: Record<string, Record<string, unknown>>
}

type OpenCodeProvider = {
  api?: string
  id?: string
  models?: Record<string, OpenCodeModel>
  npm?: string
}

type OpenCodeModelsCache = Record<string, OpenCodeProvider>

type OpenCodeMode = {
  cost?: OpenCodeModel["cost"]
  provider?: {
    body?: Record<string, unknown>
    headers?: Record<string, string>
  }
}

type OpenCodeModelMatch = {
  model: OpenCodeModel
  provider: OpenCodeProvider
  providerID: string
}

let opencodeModelsIndex: Promise<Map<string, OpenCodeModelMatch[]>> | undefined

function normalizeBaseURL(baseURL: string) {
  return baseURL.replace(/\/v1\/?$/, "").replace(/\/+$/, "")
}

function modelURL(baseURL: string, owner: string, npm?: string) {
  const cleanBase = normalizeBaseURL(baseURL)
  if (owner === "openai" || npm === NPM_PACKAGES.openai || npm === "@ai-sdk/openai-compatible") return `${cleanBase}/v1`
  return `${cleanBase}/anthropic/v1`
}

function removeProviderBaseURL(options: Record<string, unknown> | undefined) {
  if (!options) return
  delete options.baseURL
  delete options.baseUrl
  delete options.api
}

function modelPackage(owner: string) {
  if (owner === "openai") return NPM_PACKAGES.openai
  return NPM_PACKAGES.anthropic
}

function readOptionString(options: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = options?.[key]
    if (typeof value === "string" && value.length > 0) return value
  }
}

function apiKey(provider: ProviderContext["info"], options?: PluginOptions) {
  return options?.apiKey ?? readOptionString(provider.options, ["apiKey", "api_key"]) ?? provider.key
}

function baseURL(provider: ProviderContext["info"], options?: PluginOptions) {
  return options?.baseURL ?? readOptionString(provider.options, ["baseURL", "baseUrl", "api"])
}

function enrichModels(options?: PluginOptions) {
  return options?.enrichModels ?? true
}

async function readFreshCache() {
  try {
    const info = await stat(CACHE_FILE)
    if (Date.now() - info.mtimeMs > CACHE_TTL) return
    return JSON.parse(await readFile(CACHE_FILE, "utf8")) as AxonHubModelsResponse
  } catch {
    return
  }
}

async function writeCache(payload: AxonHubModelsResponse) {
  await mkdir(dirname(CACHE_FILE), { recursive: true })
  await writeFile(CACHE_FILE, JSON.stringify(payload, null, 2))
}

async function fetchModels(baseURL: string, key: string) {
  const cleanBase = normalizeBaseURL(baseURL)
  const headers = { Authorization: `Bearer ${key}` }
  const [basic, detailed] = await Promise.all([
    fetch(`${cleanBase}/v1/models`, { headers }),
    fetch(`${cleanBase}/v1/models?include=all`, { headers }),
  ])

  const payloads: AxonHubModelsResponse[] = []
  for (const response of [basic, detailed]) {
    if (!response.ok) continue
    const payload = (await response.json()) as AxonHubModelsResponse
    if (Array.isArray(payload.data)) payloads.push(payload)
  }
  if (payloads.length === 0) return { data: [] }

  const byID = new Map<string, AxonHubModel>()
  for (const payload of payloads) {
    for (const model of payload.data ?? []) {
      if (!model.id) continue
      byID.set(model.id, { ...byID.get(model.id), ...model })
    }
  }
  return { data: [...byID.values()] }
}

async function loadModels(baseURL: string, key: string) {
  const cached = await readFreshCache()
  if (cached) return cached

  const payload = await fetchModels(baseURL, key)
  await writeCache(payload)
  return payload
}

async function readOpenCodeModelsIndex() {
  opencodeModelsIndex ??= (async () => {
    try {
      const payload = JSON.parse(await readFile(OPENCODE_MODELS_FILE, "utf8")) as OpenCodeModelsCache
      const index = new Map<string, OpenCodeModelMatch[]>()

      for (const [providerID, provider] of Object.entries(payload)) {
        for (const [key, model] of Object.entries(provider.models ?? {})) {
          const match = { providerID, provider, model }
          for (const id of new Set([key, model.id].filter((value): value is string => typeof value === "string"))) {
            const existing = index.get(id)
            if (existing) existing.push(match)
            else index.set(id, [match])
          }
        }
      }

      return index
    } catch {
      return new Map<string, OpenCodeModelMatch[]>()
    }
  })()

  return opencodeModelsIndex
}

function openCodeModelMatch(item: AxonHubModel, index: Map<string, OpenCodeModelMatch[]>) {
  if (!item.id) return
  const matches = index.get(item.id)
  if (!matches?.length) return

  const owner = item.owned_by
  return (
    (owner ? matches.find((match) => match.providerID === owner) : undefined) ??
    matches.find((match) => match.providerID === "opencode") ??
    matches.find((match) => match.providerID === "openai") ??
    matches[0]
  )
}

function openCodeModesMatch(item: AxonHubModel, index: Map<string, OpenCodeModelMatch[]>) {
  if (!item.id) return
  const matches = index.get(item.id)?.filter((match) => Object.keys(match.model.experimental?.modes ?? {}).length > 0)
  if (!matches?.length) return

  const owner = item.owned_by
  return (
    (owner ? matches.find((match) => match.providerID === owner) : undefined) ??
    matches.find((match) => match.providerID === "openai") ??
    matches.find((match) => match.providerID === "opencode") ??
    matches[0]
  )
}

function hasModality(model: OpenCodeModel | undefined, direction: "input" | "output", modality: string) {
  return model?.modalities?.[direction]?.includes(modality)
}

function openCodeCost(cost: OpenCodeModel["cost"] | undefined, fallback: Model["cost"]): Model["cost"] {
  return {
    input: cost?.input ?? fallback.input,
    output: cost?.output ?? fallback.output,
    cache: {
      read: cost?.cache_read ?? fallback.cache.read,
      write: cost?.cache_write ?? fallback.cache.write,
    },
    experimentalOver200K: cost?.context_over_200k
      ? {
          input: cost.context_over_200k.input ?? fallback.experimentalOver200K?.input ?? fallback.input,
          output: cost.context_over_200k.output ?? fallback.experimentalOver200K?.output ?? fallback.output,
          cache: {
            read: cost.context_over_200k.cache_read ?? fallback.experimentalOver200K?.cache.read ?? fallback.cache.read,
            write: cost.context_over_200k.cache_write ?? fallback.experimentalOver200K?.cache.write ?? fallback.cache.write,
          },
        }
      : fallback.experimentalOver200K,
  }
}

function providerBodyOptions(body: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]))
}

function modeModel(base: Model, mode: string, options: OpenCodeMode): Model {
  return {
    ...base,
    id: `${base.id}-${mode}`,
    name: `${base.name} ${mode[0]?.toUpperCase() ?? ""}${mode.slice(1)}`,
    cost: options.cost ? openCodeCost(options.cost, base.cost) : base.cost,
    options: options.provider?.body ? providerBodyOptions(options.provider.body) : base.options,
    headers: options.provider?.headers ?? base.headers,
  }
}

function toModel(item: AxonHubModel, baseURL: string, match?: OpenCodeModelMatch): Model | undefined {
  if (!item.id) return

  const owner = item.owned_by ?? ""
  const cached = match?.model
  const name = item.name ?? item.display_name ?? cached?.name ?? item.id
  const supportsVision = item.capabilities?.vision ?? cached?.attachment ?? true
  const supportsToolCall = item.capabilities?.tool_call ?? item.capabilities?.toolCall ?? cached?.tool_call ?? true
  const supportsReasoning = item.capabilities?.reasoning ?? cached?.reasoning ?? true
  const npm = cached?.provider?.npm ?? match?.provider.npm ?? modelPackage(owner)
  const pricingCost = {
    input: item.pricing?.input ?? cached?.cost?.input ?? 0,
    output: item.pricing?.output ?? cached?.cost?.output ?? 0,
    cache: {
      read: item.pricing?.cache_read ?? item.pricing?.cacheRead ?? cached?.cost?.cache_read ?? 0,
      write: item.pricing?.cache_write ?? item.pricing?.cacheWrite ?? cached?.cost?.cache_write ?? 0,
    },
  }

  return {
    id: item.id,
    providerID: PROVIDER_ID,
    name,
    family: cached?.family,
    api: {
      id: item.id,
      url: modelURL(baseURL, owner, npm),
      npm,
    },
    capabilities: {
      temperature: cached?.temperature ?? owner !== "anthropic",
      reasoning: supportsReasoning,
      attachment: supportsVision,
      toolcall: supportsToolCall,
      input: {
        text: hasModality(cached, "input", "text") ?? true,
        audio: hasModality(cached, "input", "audio") ?? false,
        image: item.capabilities?.vision ?? hasModality(cached, "input", "image") ?? supportsVision,
        video: hasModality(cached, "input", "video") ?? false,
        pdf: hasModality(cached, "input", "pdf") ?? true,
      },
      output: {
        text: hasModality(cached, "output", "text") ?? true,
        audio: hasModality(cached, "output", "audio") ?? false,
        image: hasModality(cached, "output", "image") ?? false,
        video: hasModality(cached, "output", "video") ?? false,
        pdf: hasModality(cached, "output", "pdf") ?? false,
      },
      interleaved: cached?.interleaved ?? (owner === "anthropic" ? { field: "reasoning_content" } : false),
    },
    cost: openCodeCost(cached?.cost, pricingCost),
    limit: {
      context: item.context_length ?? cached?.limit?.context ?? 200_000,
      input: cached?.limit?.input,
      output: item.max_output_tokens ?? cached?.limit?.output ?? 32_000,
    },
    status: cached?.status ?? "active",
    options: cached?.options ?? {},
    headers: cached?.headers ?? {},
    variants: cached?.variants,
    release_date:
      item.created_at ?? (item.created ? new Date(item.created * 1000).toISOString().slice(0, 10) : cached?.release_date ?? ""),
  }
}

export const server: Plugin = async (_input, options?: PluginOptions): Promise<Hooks> => ({
  async config(config: Config) {
    config.provider ??= {}
    config.provider[PROVIDER_ID] ??= {
      name: "AxonHub",
      options: {},
      models: {},
    }

    const provider = config.provider[PROVIDER_ID]
    provider.name ??= "AxonHub"
    provider.models ??= {}
    provider.options ??= {}
    if (options?.baseURL) provider.options.baseURL = options.baseURL
    if (options?.apiKey) provider.options.apiKey = options.apiKey
  },
  provider: {
    id: PROVIDER_ID,
    async models(provider) {
      const url = baseURL(provider, options)
      const key = apiKey(provider, options)
      if (!url || !key) return {}

      removeProviderBaseURL(provider.options)

      const payload = await loadModels(url, key)
      const opencodeModels = enrichModels(options) ? await readOpenCodeModelsIndex() : new Map<string, OpenCodeModelMatch[]>()
      const result: Record<string, Model> = {}
      for (const item of payload.data ?? []) {
        const match = openCodeModelMatch(item, opencodeModels)
        const modes = openCodeModesMatch(item, opencodeModels)?.model.experimental?.modes ?? match?.model.experimental?.modes ?? {}
        const model = toModel(item, url, match)
        if (model) result[model.id] = model
        for (const [mode, modeOptions] of Object.entries(modes)) {
          if (model) result[`${model.id}-${mode}`] = modeModel(model, mode, modeOptions)
        }
      }
      return result
    },
  },
})

export default { id: "opencode-axonhub", server }
