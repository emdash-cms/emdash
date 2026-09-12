---
"emdash": patch
---

Fixes the admin UI (dashboard, login, and the setup wizard) returning a completely empty response when `fonts: false` is set in the `emdash()` integration config. Previously, disabling fonts left the admin shell rendering a `<Font>` reference to a family that was never registered, which threw partway through the response and produced a 200 with no body.
