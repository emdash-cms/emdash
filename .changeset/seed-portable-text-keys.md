---
"emdash": patch
---

Fixes autosave validation errors on content seeded from templates whose
Portable Text blocks omit `_key` (issue #867). `applySeed` now injects
a stable `_key` on every PT-shaped node (block, span, mark def, custom
plugin block) before persisting, so seeded entries round-trip cleanly
through the same Zod validator the autosave endpoint uses. Keys
already present in the seed file are preserved verbatim; generated
keys avoid colliding with explicit ones elsewhere in the same entry.
