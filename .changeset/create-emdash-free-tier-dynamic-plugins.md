---
"create-emdash": patch
---

Scaffolds Cloudflare projects that deploy on the Workers free tier out of the box. The Worker Loader binding — needed only for dynamic plugins, which require the Workers paid plan — now ships commented out. Opt in by answering "yes" to the new dynamic-plugins prompt, or pass `--dynamic-plugins` (use `--no-dynamic-plugins` to keep it off non-interactively).
