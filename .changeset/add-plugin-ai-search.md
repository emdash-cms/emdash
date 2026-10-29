---
"@emdash-cms/plugin-ai-search": minor
---

Adds `@emdash-cms/plugin-ai-search`, a plugin that indexes published content and author profiles into Cloudflare AI Search and keeps the index current as content changes. Set it up from the admin wizard, then add the `AiSearch` Astro component to a layout for a search button and modal. Requires EmDash 1.0.1 or later. It replaces `aiSearch` from `@emdash-cms/cloudflare/plugins`; the [AI Search plugin guide](https://docs.emdashcms.com/plugins/ai-search/) covers setup and switching.

The plugin connects through an `ai_search_namespaces` binding on Cloudflare Workers, or through the Cloudflare REST API on Node.js and on Workers without a binding. For the REST API, set `EMDASH_AI_SEARCH_ACCOUNT_ID` and `EMDASH_AI_SEARCH_API_TOKEN`, or enter the account ID and API token on the plugin's settings page, which stores the token encrypted and requires `EMDASH_ENCRYPTION_KEY`. `EMDASH_AI_SEARCH_NAMESPACE` selects a namespace other than `default`. When a site has both a binding and a token, the plugin uses the binding.

To protect the API token's Cloudflare rate limit, indexing through the REST API uses at most half of it, and each EmDash process allows a visitor 30 REST API searches a minute, counted per IP address. Self-hosted sites behind a reverse proxy need `trustedProxyHeaders` for the search limit to apply.
