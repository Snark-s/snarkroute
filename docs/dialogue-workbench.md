# Dialogue Workbench

Dialogue Workbench is a special BoojumRoute Lab node for conversations. It appears as a normal graph block with ports, but opens into a large editor for message history, connected inputs, context capsules, model profile selection, and selected outputs.

## Inputs

- `text`: briefs, prompts, or another workbench's `conversation_text`.
- `image`: reference or generated images.
- `json`: structured artifacts.
- `context`: `conversation_capsule` from a previous Dialogue Workbench.
- `file`: planned portable file input type.

Connected capsules are shown separately from normal text/image/json inputs.

## Outputs

- `conversation_text`: markdown transcript for humans.
- `conversation_json`: full structured transcript for audit/export/debug.
- `conversation_capsule`: compact structured continuation context.
- Dynamic selected outputs: user-created ports such as `final_prompt`, `selected_image`, `critique`, or `style_notes`.

`conversation_text` can be connected to another Dialogue Workbench as text. `conversation_capsule` connects to the special `context` input.

## Output Semantics

`conversation_text` is readable markdown with inputs, messages, model labels, image/file refs, and selected outputs.

`conversation_json` is the full transcript: conversation id, node id, messages, content parts, model metadata, selected outputs, pinned flags, timestamps, artifact refs, and parent conversation refs. It must not contain credentials.

`conversation_capsule` is compact continuation context: summary, decisions, assumptions, unresolved questions, pinned artifacts, selected outputs, and parent conversation ids. The first implementation uses pinned messages and selected outputs; it does not make hidden LLM calls.

## Execution Behavior

Graph execution does not automatically continue a dialogue. It emits the current saved outputs only: system transcript outputs and selected/locked user outputs. No provider calls are made during route execution.

## Example Scenario

1. **Dialogue 1** takes a reference image and brief. The user discusses a prompt, pins key notes, and selects `final_prompt`. The node also emits `conversation_capsule`.
2. **Image Generation Node** receives `final_prompt` and generates an image.
3. **Dialogue 2** receives the generated image and Dialogue 1's `conversation_capsule`, then continues the discussion without needing the full raw transcript.

The three system outputs are separate because `conversation_text` is for people, `conversation_json` is for audit and migration, and `conversation_capsule` is for compact model continuation.

## Current Files

- Types and generators: `packages/protocol/src/dialogue-workbench.ts`
- Built-in runner and manifest: `packages/nodes/src/index.ts`
- BoojumRoute Lab UI: `apps/studio/src/main.tsx`
