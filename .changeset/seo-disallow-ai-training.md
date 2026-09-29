---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds a **Disallow AI training** option to **Settings > SEO**. When it is on, `/robots.txt` disallows the AI training crawlers and opt-out tokens `Amazonbot`, `Applebot-Extended`, `Bytespider`, `CCBot`, `ClaudeBot`, `Google-Extended`, `GPTBot`, and `meta-externalagent`, and adds a `Content-Signal: search=yes, ai-train=no` line. Search engine access stays as your other rules define it. The rules are added to both the default and a custom `robots.txt`. The option is also available as `seo.disallowAiTraining` in the settings API and the MCP `settings_update` tool. It is off by default, so existing `robots.txt` output is unchanged.
