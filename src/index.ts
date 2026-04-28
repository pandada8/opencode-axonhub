import type { Config, Hooks, Plugin, ProviderContext } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const PROVIDER_ID = "axonhub"
const CACHE_FILE = join(homedir(), ".cache", "opencode", "axonhub-models.json")
const CACHE_TTL = 24 * 60 * 60 * 1000

const NPM_PACKAGES = {
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai",
} as const

type PluginOptions = {
  baseURL?: string
  apiKey?: string
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

function normalizeBaseURL(baseURL: string) {
  return baseURL.replace(/\/v1\/?$/, "").replace(/\/+$/, "")
}

function modelURL(baseURL: string, owner: string) {
  const cleanBase = normalizeBaseURL(baseURL)
  if (owner === "openai") return `${cleanBase}/v1`
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

function toModel(item: AxonHubModel, baseURL: string): Model | undefined {
  if (!item.id) return

  const owner = item.owned_by ?? ""
  const name = item.name ?? item.display_name ?? item.id
  const supportsVision = item.capabilities?.vision ?? true
  const supportsToolCall = item.capabilities?.tool_call ?? item.capabilities?.toolCall ?? true
  const supportsReasoning = item.capabilities?.reasoning ?? true

  return {
    id: item.id,
    providerID: PROVIDER_ID,
    name,
    api: {
      id: item.id,
      url: modelURL(baseURL, owner),
      npm: modelPackage(owner),
    },
    capabilities: {
      temperature: owner !== "anthropic",
      reasoning: supportsReasoning,
      attachment: supportsVision,
      toolcall: supportsToolCall,
      input: { text: true, audio: false, image: supportsVision, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: owner === "anthropic" ? { field: "reasoning_content" } : false,
    },
    cost: {
      input: item.pricing?.input ?? 0,
      output: item.pricing?.output ?? 0,
      cache: {
        read: item.pricing?.cache_read ?? item.pricing?.cacheRead ?? 0,
        write: item.pricing?.cache_write ?? item.pricing?.cacheWrite ?? 0,
      },
    },
    limit: {
      context: item.context_length ?? 200_000,
      output: item.max_output_tokens ?? 32_000,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: item.created_at ?? (item.created ? new Date(item.created * 1000).toISOString().slice(0, 10) : ""),
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
      const result: Record<string, Model> = {}
      for (const item of payload.data ?? []) {
        const model = toModel(item, url)
        if (model) result[model.id] = model
      }
      return result
    },
  },
})

export default { id: "opencode-axonhub", server }
