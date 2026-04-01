---
"create-emdash": patch
---

Fix spinner hanging during dependency installation by using async exec instead of execSync, which was blocking the event loop and preventing the spinner animation from updating.
