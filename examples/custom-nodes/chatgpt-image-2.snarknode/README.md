# ChatGPT Image 2

Generates or edits one image through OpenAI image generation.

## Inputs

- `prompt` text input, optional. Overrides the node prompt parameter when connected.
- `images` image input, optional. Connect multiple image edges to this port to edit or compose from references.

## Parameters

- `prompt`: prompt stored directly on the node.
- `model`: defaults to `chatgpt-image-latest`.
- `size`: `auto`, `1024x1024`, `1536x1024`, or `1024x1536`.
- `quality`: `auto`, `low`, `medium`, or `high`.
- `outputFormat`: `png`, `jpeg`, or `webp`.
- `background`: `auto`, `transparent`, or `opaque`.

## Output

- `image`: generated local image asset.

## Secrets

Set `OPENAI_API_KEY` before running this node.
