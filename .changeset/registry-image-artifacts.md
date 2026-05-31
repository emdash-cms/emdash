---
"@emdash-cms/plugin-cli": minor
"emdash": minor
"@emdash-cms/admin": minor
---

Plugins published to the experimental registry can now ship icon, screenshot, and banner images. Declare them in `emdash-plugin.jsonc` under `release.artifacts` as file refs; `emdash-plugin publish --artifact-base-url <url>` measures each image's dimensions, uploads it, and records it in the release. The admin plugin detail page renders the icon, banner, and a screenshot gallery, fetched through a server-side image proxy. The proxy resolves each artifact's URL server-side from the validated release record (the client sends only the artifact's coordinates, never a URL), then applies SSRF defences and an image content-type allowlist before serving the bytes. Supported image types are PNG, JPEG, WebP, GIF, and AVIF; SVG is rejected at both publish and proxy because it is active content.
