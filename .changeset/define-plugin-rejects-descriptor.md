---
"emdash": patch
---

Fixes `definePlugin()` silently producing a plugin with no hooks when given a plugin descriptor, such as the result of `cloudflareEmail({...})`. The wrapped plugin registered normally but did nothing, so a wrapped email provider left the site with no email delivery. `definePlugin()` now throws an error that names the plugin, so a site that still wraps a descriptor fails to start until the wrapper is removed. Pass the descriptor directly to the `plugins` array of the `emdash()` integration instead:

```js
// Before: a local plugin module whose createPlugin() returns
// definePlugin(cloudflareEmail({ from: "cms@mails.example.com" }))

// After, in astro.config.mjs
emdash({
	plugins: [cloudflareEmail({ from: "cms@mails.example.com" })],
});
```
