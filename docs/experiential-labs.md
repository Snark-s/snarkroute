# Experiential Labs

In SnarkRoute, open Settings → AI Providers → Experiential Labs, paste your
organization API key, save it, and use Test connection. Keys are created at
https://platform.experientiallabs.ai/ in Settings → API Keys.

The server stores the key locally as `EXPLABS_API_KEY`. It is never included in
route documents. Restart the server when setting this variable outside the UI.

The integration lists authorized slugs from `GET https://api.experientiallabs.ai/v1/models`
and runs text prompts through `POST /v1/chat/completions`. Select the Experiential
Labs provider route for a model in a text node. Its stored parameters are
`executionProvider: experiential` and `providerModelId: <exact gateway slug>`.

This integration supports text inputs and text outputs, optional system prompts,
temperature and output token limits. Image, audio, tool execution and streaming
are not exposed by this integration. Token usage and provider identity are
retained; cost remains unknown because the gateway can choose different provider
waterfalls. Model availability and account/region restrictions are enforced by
Experiential Labs.

Connection testing only lists models; it does not run paid inference.

API contract: https://platform.experientiallabs.ai/docs/core-loop
Authentication: https://platform.experientiallabs.ai/docs/authentication
