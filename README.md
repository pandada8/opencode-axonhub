# @pandada8/opencode-axonhub

OpenCode plugin that discovers AxonHub models from `/v1/models` and `/v1/models?include=all`, merges both responses, and exposes them as the `axonhub` provider.

Models are cached at `~/.cache/opencode/axonhub-models.json` for one day. If no API key is configured, discovery returns no models.

API keys can be stored with OpenCode auth as provider `axonhub`; on Linux this is written to `~/.local/share/opencode/auth.json`.

## Usage

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
