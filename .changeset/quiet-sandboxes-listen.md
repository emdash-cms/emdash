---
"@emdash-cms/cloudflare": patch
"create-emdash": patch
"emdash": patch
---

New Cloudflare projects leave the paid-plan Worker Loader binding disabled so they can deploy on the Workers free plan. Enable sandboxed plugins in the scaffold prompt or with `--sandboxed-plugins`.

The Cloudflare `sandbox()` helper now selects the runner from the `LOADER` binding in `wrangler.jsonc`, including the named environment selected with `CLOUDFLARE_ENV`. Without it, config-based sandboxed plugins do not load and marketplace or registry installs return `SANDBOX_NOT_AVAILABLE`, while browsing remains available.
