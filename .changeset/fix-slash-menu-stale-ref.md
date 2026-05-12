---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes a stale ref race in the slash command menu's keyboard handlers. The state ref was synced via `useEffect` (post-commit), so TipTap's Suggestion plugin could read stale state when invoking `onKeyDown` synchronously -- causing Enter to occasionally fail to execute commands and arrow navigation to skip selections on slower runs.
