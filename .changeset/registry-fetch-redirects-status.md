---
"emdash": patch
---

Fixes two problems with how registry plugin requests handle unusual responses:

- Registry plugin verification, install, update, update checks, and the registry image proxy no longer follow HTTP redirects from the aggregator. A redirect is now reported as an aggregator error. If your `registry` option points at a URL that redirects, change it to the final URL.
- On Node.js, a registry plugin's icon, banner, screenshot, or bundle host that answers with an HTTP status outside 200–599 no longer stops the server process. The download now fails like any other unavailable artifact.
