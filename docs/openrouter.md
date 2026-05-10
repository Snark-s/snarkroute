# OpenRouter in SnarkRoute

OpenRouter is the primary remote AI provider for SnarkRoute. The MVP path is intentionally simple:

```text
SnarkRoute -> OpenRouter -> supported remote models
```

Direct provider adapters such as Gemini and Replicate are still kept for Advanced/Direct mode and for models or output formats that OpenRouter does not support yet. Local models do not go through OpenRouter.

## Get an API key

1. Open Settings in SnarkRoute.
2. In **AI Providers**, use **Get API Key**.
3. Create or copy an OpenRouter API key.
4. Paste it into **OpenRouter API Key**.
5. Click **Save**, then **Test Connection**.

OpenRouter may redirect you to sign in before showing keys or credits.

## Credits

Use **Add Credits** in Settings, or open:

```text
https://openrouter.ai/settings/credits
```

SnarkRoute only stores provider metadata and usage returned by providers. It does not sell credits, manage wallets, or run a marketplace payment system in this MVP.

## Model Catalog

Click **Refresh Model Catalog** in Settings to call:

```text
GET https://openrouter.ai/api/v1/models
```

The cached catalog is stored locally at:

```text
data/cache/openrouter-models.json
```

The cache includes model ids, names, descriptions, modalities, context length, pricing, supported parameters, and top provider metadata when OpenRouter returns those fields. Missing optional fields are tolerated.

## Default Model

The Settings default model is stored as `OPENROUTER_DEFAULT_MODEL` in the local `.env` file. The API key is stored as `OPENROUTER_API_KEY` in the same local `.env` file.

Do not commit API keys to git.

## OpenRouter vs Direct Mode

Normal task nodes show a simple model selector and keep provider choice in **Advanced**:

- **Auto** uses OpenRouter when the model mapping is verified.
- **Auto** falls back to an existing direct provider when the OpenRouter mapping is unknown.
- **OpenRouter** forces OpenRouter and fails clearly if no OpenRouter model id is mapped.
- **Direct** uses the older direct provider adapter when configured.

Use Direct mode when a model, media output format, or provider feature has not been verified through OpenRouter yet.

## Local Models

Local models stay local. They are not routed through OpenRouter because they run on the user's machine or LAN service and do not require a remote provider key.

## Add a Model Mapping

Mappings live in:

```text
data/model-registry/openrouter-mappings.json
```

Add a mapping only when the OpenRouter model slug is verified in the cached catalog or official docs. Do not guess slugs. For unknown mappings, set:

```json
{
  "status": "unknown",
  "openrouterModel": null,
  "notes": "Verify via catalog before enabling."
}
```

## Provider Links

Settings links are configured in:

```text
data/provider-links.json
```

The backend exposes them through:

```text
GET /api/providers/links
```

The UI should use this endpoint instead of hardcoding provider URLs in components.

## Secret Safety

The OpenRouter key is never returned by `/api/settings`; the UI receives only a masked value. Keys should not be placed in route params, exported routes, logs, or client-side errors.

Ignored secret paths include:

```text
.env
.env.local
data/secrets/*
data/settings/secrets.json
```
