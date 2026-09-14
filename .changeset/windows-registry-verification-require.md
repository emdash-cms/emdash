---
"@emdash-cms/registry-verification": patch
---

Fixes sites on Windows failing every request with "The argument 'filename' must be a file URL object" when the registry verification module loads. The generated `require` shim now uses the module's own URL and only falls back to a fixed base when it has been rebundled.
