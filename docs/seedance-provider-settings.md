# Seedance Provider Settings

Seedance video generation in SnarkRoute is configured through official ByteDance cloud products, not through third-party aggregators.

## Backends

- BytePlus ModelArk is the international access path. Use backend `byteplus-modelark` or alias `seedance-byteplus`.
- Volcengine LAS is the China-region access path. Use backend `volcengine-las` or alias `seedance-volcengine`.
- Custom Seedance-compatible endpoints remain available as backend `seedance-compatible` for existing local workflows.

## Environment Variables

- `SEEDANCE_PROVIDER_BACKEND`: `byteplus-modelark`, `volcengine-las`, or `seedance-compatible`.
- BytePlus ModelArk key: `ARK_API_KEY` or `BYTEPLUS_ARK_API_KEY`.
- Volcengine LAS key: `LAS_API_KEY` or `VOLCENGINE_LAS_API_KEY`.
- Legacy/custom key: `SEEDANCE_API_KEY`.
- Custom base URL override: `SEEDANCE_API_BASE_URL`.

Official backends provide default base URLs:

- BytePlus ModelArk: `https://ark.ap-southeast.bytepluses.com/api/v3`
- Volcengine LAS: `https://operator.las.cn-beijing.volces.com/api/v1`

`SEEDANCE_API_BASE_URL` is required only when using `seedance-compatible`, or when intentionally overriding an official backend endpoint.

## Studio UI

Open Settings, then Advanced / Direct Secrets, then Seedance. Choose the provider backend, paste the matching API key, and optionally set Advanced: Custom API Base URL.

The configured status requires a selected backend, an API key, and either an official backend default base URL or a custom base URL. If only a key is saved, Studio reports `key saved, provider/base URL not verified`.

Official links:

- BytePlus ModelArk product: https://www.byteplus.com/product/modelark
- BytePlus API keys: https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey
- Volcengine LAS API key docs: https://www.volcengine.com/docs/6492/1799875
- Volcengine Seedance operator docs: https://www.volcengine.com/docs/6492/2165104
