---
"@emdash-cms/plugin-cli": minor
"emdash": minor
"@emdash-cms/admin": minor
---

Plugins published to the experimental registry can now ship icon, screenshot, and banner images. Declare them in `emdash-plugin.jsonc` under `release.artifacts` as file refs; `emdash-plugin publish --artifact-base-url <url>` measures each image's dimensions, uploads it, and records it in the release. The admin plugin detail page renders the icon, banner, and a screenshot gallery, fetched through a server-side image proxy that applies SSRF defences and an image content-type allowlist to the arbitrary publisher-supplied URLs.
