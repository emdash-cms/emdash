---
"emdash": minor
---

**Breaking:** generated TypeScript interface names in `emdash-env.d.ts` now derive from the collection **slug** instead of `labelSingular`. This fixes invalid identifiers (labels with spaces/punctuation) and duplicate identifiers (two collections sharing a label), but it renames interfaces for existing collections — e.g. `Page` → `Pages`, `BlogPost` → `BlogPosts`. Users should regenerate `emdash-env.d.ts` (`emdash types` or dev-server start) and update any direct interface references in their code.
