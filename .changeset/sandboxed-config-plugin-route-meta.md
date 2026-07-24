---
"emdash": patch
---

Fixes public routes on `sandboxed: []` (config-declared) plugins requiring authentication regardless of the plugin's own `public: true` declaration. Declare `routes` (and optionally `hooks`) on the plugin's descriptor to have them honored, the same way `adminPages`/`capabilities` already are.
