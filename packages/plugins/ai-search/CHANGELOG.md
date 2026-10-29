# @emdash-cms/plugin-ai-search

## 0.1.0

### Minor Changes

- [#4071](https://github.com/emdash-cms/emdash/pull/4071) [`772838d`](https://github.com/emdash-cms/emdash/commit/772838d20a748a42d9e1c03ad94a992006745bef) Thanks [@ttmx](https://github.com/ttmx)! - Adds `@emdash-cms/plugin-ai-search`, a site search plugin powered by Cloudflare AI Search. It indexes published content and author profiles, keeps the index current as content changes, and adds an `AiSearch` component with a search button and modal. Choose what to index in the plugin's setup wizard in the admin. Requires EmDash 1.0.1 or later.
  
  The plugin connects through an AI Search binding on Cloudflare Workers, or through a Cloudflare API token on any platform, including Node.js.
  
  This plugin replaces `aiSearch` from `@emdash-cms/cloudflare/plugins`. The [AI Search plugin guide](https://docs.emdashcms.com/plugins/ai-search/) covers setup, API token rate limits and switching.
