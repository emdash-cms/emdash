---
"emdash": patch
---

Fixes a type error in the shipped WordPress-plugin import source: the analyze-endpoint error body from `response.json()` is `unknown` under `@cloudflare/workers-types` and was read without narrowing. This file ships as raw source via the `emdash/routes/*` export, so the error surfaced in strict consumer typechecks (issue #1053). The body is now typed before `.message` is read; runtime behaviour is unchanged.
