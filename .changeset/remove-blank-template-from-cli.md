---
"create-emdash": patch
---

Removes the "Blank" template from the `npm create emdash` picker. The minimal-content template is `starter`; the previously listed `blank` only existed for the Node.js path (never Cloudflare) and was confusing. Pick `Starter` for a minimal site on either platform.
