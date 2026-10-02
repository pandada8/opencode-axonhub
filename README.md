# @pandada8/opencode-axonhub

OpenCode v2 plugin that discovers AxonHub models from `/v1/models` and `/v1/models?include=all`, merges both responses, and exposes them as the `axonhub` provider through the catalog.

It targets the opencode v2 plugin format: the module default-exports a definition with an `id` and a `setup(ctx)` function (see `@opencode/plugin`). Models are cached at `~/.cache/opencode/axonhub-models.json` for one day. If no base URL or API key is configured, no models are registered.

## Usage

Add the plugin and an `axonhub` provider entry to `opencode.jsonc`. Provide the endpoint and API key as plugin options, provider options, or environment variables.

```json
{
  "plugin": [["@pandada8/opencode-axonhub", { "baseURL": "https://your-axonhub.example.com", "apiKey": "ah-..." }]],
  "provider": {
    "axonhub": {
      "options": {
        "baseURL": "https://your-axonhub.example.com"
      },
      "models": {}
    }
  }
}
```

Alternatively, set the key via environment so it never lands in config:

```sh
export AXONHUB_BASE_URL="https://your-axonhub.example.com"
export AXONHUB_API_KEY="ah-..."
```

Resolution order for the endpoint/key: plugin options (`baseURL`/`apiKey`) -> configured provider options (`provider.axonhub.options.baseURL` / `apiKey`) -> environment (`AXONHUB_BASE_URL`, `AXONHUB_API_KEY`). If neither is found, the plugin registers nothing.

## Routing

Each model is routed to the vendor protocol AxonHub expects through its per-model SDK package and endpoint:

- OpenAI models -> `@ai-sdk/openai` against `/v1`
- Gemini/Google -> `@ai-sdk/google` against `/gemini/v1beta`
- everything else -> `@ai-sdk/anthropic` against `/anthropic/v1`

Because opencode v2 stores the endpoint per model (there is no per-model `api.url`), the plugin sets each model's `settings.baseURL` accordingly, while exposing all of them under the single `axonhub` provider.

## Notes

- Model enrichment from OpenCode's `~/.cache/opencode/models.json` and `experimental.modes` (`*-fast` variants) are not yet ported to the v2 API.
- Requires opencode v2 (tested against 2.0.18).