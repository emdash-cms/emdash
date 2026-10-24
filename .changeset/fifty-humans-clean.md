---
"emdash": patch
---

Fixes email delivery in `astro dev` so a single real email provider replaces the console fallback, including sites with a previously stored console selection. Email settings shows the active provider even when the console is selected only in memory.

Stored console selections, including ones made through the admin API, are cleared on startup or plugin enable/disable. To keep development emails out of a real provider, disable that provider in development. With multiple real providers and no saved real-provider choice or preferred hint, delivery remains unconfigured until a provider is selected through the admin API.
