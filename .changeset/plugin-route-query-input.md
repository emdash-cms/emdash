---
"emdash": patch
---

Plugin API routes with an input schema now work over GET, HEAD, and DELETE. These methods carry no request body, so `request.json()` resolved to `undefined` and every such request failed validation. Route input is now parsed from the URL query string for bodyless methods (repeated keys become arrays) while POST/PUT/PATCH continue to parse the JSON body.
