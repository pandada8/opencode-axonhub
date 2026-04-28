# @pandada8/opencode-axonhub

OpenCode plugin that discovers AxonHub models from `/v1/models` and `/v1/models?include=all`, merges both responses, and exposes them as the `axonhub` provider.

Models are cached at `~/.cache/opencode/axonhub-models.json` for one day. If no API key is configured, discovery returns no models.

By default, discovered AxonHub models are enriched from OpenCode's default model cache at `~/.cache/opencode/models.json`. The plugin matches entries by model `id` and uses the cached metadata to fill OpenCode-specific fields such as `family`, capabilities, modalities, cost, limits, provider package, headers, options, and variants. AxonHub still provides the actual `api.id` and AxonHub endpoint URL used for requests.

If the matched OpenCode metadata defines `experimental.modes`, the plugin also exposes those modes as separate models with the mode suffix. For example, when OpenCode's cache defines a `fast` mode for `gpt-5.4`, `gpt-5.5`, or `gpt-5.4-mini`, AxonHub will expose both the base model and the corresponding `gpt-5.4-fast`, `gpt-5.5-fast`, or `gpt-5.4-mini-fast` model.

API keys can be stored with OpenCode auth as provider `axonhub`; on Linux this is written to `~/.local/share/opencode/auth.json`.

## Usage

Add the `axonhub` provider to `opencode.jsonc` before logging in or fetching models. Without this provider entry, OpenCode cannot discover the AxonHub model list.

```json
{
  "plugin": ["@pandada8/opencode-axonhub"],
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

To disable enrichment from `~/.cache/opencode/models.json`, pass plugin options with `enrichModels` set to `false`:

```json
{
  "plugin": [["@pandada8/opencode-axonhub", { "enrichModels": false }]],
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

When `enrichModels` is disabled, the plugin only uses AxonHub's model responses and does not create `experimental.modes` derived models such as `*-fast`.

Then store the API key with OpenCode:

```sh
opencode auth login --provider axonhub
```

You can also set `provider.axonhub.options.apiKey` directly, for example with `{env:AXONHUB_API_KEY}`.

Or manually edit `~/.local/share/opencode/auth.json`:

```json
{
  "axonhub": {
    "type": "api",
    "key": "ah-your-api-key"
  }
}
```

If the file already contains other providers, add `axonhub` as another top-level key. Keep the file private:

```sh
chmod 600 ~/.local/share/opencode/auth.json
```

OpenAI-owned models use `@ai-sdk/openai` against the AxonHub `/v1` endpoint. All other models use `@ai-sdk/anthropic` against the AxonHub `/anthropic/v1` endpoint.
