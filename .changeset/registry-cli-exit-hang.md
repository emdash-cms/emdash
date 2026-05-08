---
"@emdash-cms/registry-cli": patch
---

Fixes the CLI hanging indefinitely after a successful `login` or `logout`. `run()` was returning correctly, but something in the OAuth path left a ref'd handle alive that prevented Node's event loop from draining. Workaround: force-exit at the top level once `runMain` resolves. The underlying handle leak is unidentified.
