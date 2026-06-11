# SnarkRoute UI Agent Instructions

- UI must not hardcode model output types, icons, or generation parameters.
- UI should consume `/api/models`.
- Do not add model name regexes in UI.
- Do not modify model catalog logic unless the task explicitly asks for model, provider, or catalog changes.
