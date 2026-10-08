---
"@emdash-cms/plugin-ai-search": minor
---

Adds `@emdash-cms/plugin-ai-search`, which indexes published content and author profiles into a Cloudflare AI Search instance and serves search to the site. Each entry's author names and taxonomy terms, such as categories and tags, are indexed with it, so searching for one finds the entries that carry it. An admin setup wizard chooses what to index and builds the index, and the `AiSearch` Astro component adds a search button and modal to any page:

```js title="astro.config.mjs"
import { aiSearch } from "@emdash-cms/plugin-ai-search";

emdash({ plugins: [aiSearch()] });
```

```astro
---
import { AiSearch } from "@emdash-cms/plugin-ai-search/astro";
---

<AiSearch />
```

The plugin runs only on Cloudflare Workers and needs an `ai_search_namespaces` binding.
