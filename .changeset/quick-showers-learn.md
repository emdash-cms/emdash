---
"emdash": patch
---

Fixes the visual-editing toolbar appearing unstyled and unresponsive on sites using Astro's hash-based Content Security Policy. EmDash now registers stable toolbar script and stylesheet hashes when Astro CSP is enabled, and toolbar markup no longer needs inline style attributes. Sites managing their own CSP can allow the toolbar script with a hash that stays stable across sessions and languages for a given EmDash version. Update those hashes when upgrading EmDash.
