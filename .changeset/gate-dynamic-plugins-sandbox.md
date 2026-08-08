---
"emdash": patch
---

Gates the admin marketplace and registry screens behind sandbox availability. On a deployment with no sandbox runner — for example a Cloudflare free-tier site without the Worker Loader binding — the browse and install views are replaced with a prompt explaining that dynamic plugins need Worker Loader (a Workers paid-plan feature) and how to enable it, instead of letting an install fail with a 503. The manifest now reports a `sandboxAvailable` flag.
