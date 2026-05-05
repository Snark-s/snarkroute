# Context Budget Skill

Use this workflow for every normal task in this repository unless the user explicitly requests broad analysis, architecture review, repository-wide audit, or large refactoring.

## Purpose

Reduce token usage and avoid unnecessary context loading by working only with the smallest relevant part of the repository.

## Mandatory rules

- Do not scan the whole repository by default.
- Start by identifying the smallest relevant area for the task.
- First list the minimal files that need inspection.
- Read only files needed for the current task.
- Do not read archives, generated files, old reports, large docs, or unrelated folders unless explicitly needed.
- Do not refactor unrelated code.
- Prefer the smallest safe change.
- Prefer focused tests and checks over full-repository checks unless the task is broad.
- If additional files must be inspected, explain why.
- If the task scope is unclear, make the narrowest reasonable assumption and state it.

## Default workflow

1. Identify the minimal relevant area.
2. List the minimal files to inspect.
3. Inspect only those files first.
4. Make the smallest safe change.
5. Run focused verification.
6. Summarize changed files, verification results, and risks.

## Response pattern

Use this structure for implementation tasks:

~~~text
Minimal relevant area:
- ...

Files to inspect:
- ...

Planned change:
- ...

Change made:
- ...

Focused verification:
- ...

Files changed and risks:
- ...
~~~

## Broad scans

Only inspect the whole repository when the user explicitly asks for one of these:

- repository-wide architecture review
- global refactor
- full audit
- dependency-wide investigation
- project-wide documentation update
- security or consistency review across the whole codebase

Otherwise, stay local.
