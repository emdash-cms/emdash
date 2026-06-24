---
"emdash": minor
---

**Breaking:** generated TypeScript interface names in `emdash-env.d.ts` now derive from the collection **slug** (singularized) instead of `labelSingular`. This fixes invalid identifiers (labels with spaces/punctuation) and duplicate identifiers (two collections sharing a label), while keeping names singular so each interface reads as a single entry (slug `posts` → `Post`, `blog_posts` → `BlogPost`). Interfaces are renamed wherever the old label-derived name differed from the slug. Users should regenerate `emdash-env.d.ts` (`emdash types` or dev-server start) and update any direct interface references in their code.
