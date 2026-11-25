---
"emdash": patch
---

Fixes GitHub, Google, and Microsoft sign-in so the callback only signs in the browser that started the sign-in. Opening a callback link that was started in another browser now returns to the login page with `invalid_state` and leaves the current session unchanged.

Starting a sign-in now sets a short-lived `HttpOnly` cookie named `emdash_oauth_state_` followed by part of the sign-in's state, which the callback checks. Sign-ins started in several tabs of one browser can each finish. A sign-in that is in progress during the upgrade has to be started again. If you set a site URL, start sign-in from that host name: a sign-in started on another host name, such as `www.` instead of the bare domain, fails with `invalid_state`.
