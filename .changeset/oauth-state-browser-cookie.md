---
"emdash": patch
---

Fixes GitHub, Google, and Microsoft sign-in so the callback only signs in the browser that started the sign-in. Opening a callback link that was started in another browser now returns to the login page with `invalid_state` and leaves the current session unchanged.

Starting a sign-in now sets a short-lived `HttpOnly` cookie, `emdash_oauth_state`, that the callback checks. A sign-in that is in progress during the upgrade, or that starts and finishes on different host names, has to be started again.
