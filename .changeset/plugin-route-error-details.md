---
"emdash": patch
---

Fixes trusted (in-process) plugin API routes dropping error `details`: a route that throws `PluginRouteError.badRequest(message, details)`, or whose `input` schema rejects the request, now returns those details in the JSON error body (`error.details`), so a form can show which fields failed. Unexpected errors still return only a generic message.
