---
"@emdash-cms/plugin-ai-search": minor
---

Adds `@emdash-cms/plugin-ai-search`, a plugin that indexes published content and author profiles into Cloudflare AI Search and keeps the index current as content changes. Set it up from the admin wizard, then add the `AiSearch` Astro component to a layout for a search button and modal. Requires EmDash 1.0.1 or later, Cloudflare Workers, and an `ai_search_namespaces` binding. See the [AI Search plugin guide](https://docs.emdashcms.com/plugins/ai-search/).

It replaces `aiSearch` from `@emdash-cms/cloudflare/plugins`; the guide covers switching.
