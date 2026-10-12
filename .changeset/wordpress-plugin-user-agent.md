---
"emdash": patch
---

Send an identifying `User-Agent: EmDash-Importer/1.0` header on all WordPress plugin importer requests. Without this header, hosts that block requests with an empty User-Agent (such as ScalaHosting's bot filter) returned 403 during analyze and media import. The plugin API fetcher now adds the header to every request, and direct media downloads from `fetchMedia` send the same value. This matches the existing media import route behavior.
