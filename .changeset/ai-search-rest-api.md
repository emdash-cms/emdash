---
"@emdash-cms/plugin-ai-search": minor
---

The AI Search plugin now runs on Node.js and on Workers without an AI Search binding, by connecting through the Cloudflare REST API. Set `EMDASH_AI_SEARCH_ACCOUNT_ID` and `EMDASH_AI_SEARCH_API_TOKEN`, or enter the account ID and API token on the plugin's settings page, which stores the token encrypted and requires `EMDASH_ENCRYPTION_KEY`. `EMDASH_AI_SEARCH_NAMESPACE` selects a namespace other than `default`. A Workers binding, when present, is still used first. To protect the API token's Cloudflare rate limit, indexing through the REST API uses at most half of it, and each visitor can search 30 times a minute, counted per IP address. Self-hosted sites behind a reverse proxy need `trustedProxyHeaders` for the search limit to apply.
