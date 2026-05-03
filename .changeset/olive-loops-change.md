---
"create-emdash": patch
---

Fixes interactive `Project name?` prompt to accept `.` for the current directory. The flag-positional path already accepted `.` (validated by `validateProjectName`), but the prompt's inline regex check rejected it, so users running `npm create emdash@latest` with no arguments could not scaffold into the current directory. The prompt now uses `validateProjectName` directly for parity, and its message hints at the `.` option.
