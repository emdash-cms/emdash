---
"emdash": patch
---

Fixes the command `emdash login` suggests after "Device Flow is not available for this instance.", such as on a site that uses Cloudflare Access for sign-in. The suggested `emdash --token` command failed with "Unknown command"; the hint now shows `emdash schema list --url <url> --token <token>`, and when login got past Cloudflare Access with `--header` flags, `EMDASH_HEADERS` or cloudflared, it also says how to pass that access with each command.
