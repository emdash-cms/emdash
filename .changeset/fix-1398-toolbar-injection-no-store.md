---
"emdash": patch
---

fix(core): set Cache-Control: private, no-store on editor toolbar-injected HTML (#1398)

The request-context middleware injected the editor toolbar into public HTML for a logged-in editor but, unlike the preview branch, did not set `Cache-Control: private, no-store`. On a site fronted by a shared cache (Cloudflare, etc.), an editor merely browsing the public site primed the edge cache with toolbar-bearing HTML that was then served to all anonymous visitors — leaking the toolbar markup and the fact that a session was active.

`injectToolbar` now sets `Cache-Control: private, no-store` on the actual-injection path, mirroring the preview branch, so toolbar-bearing (session-specific) responses are never shared-cacheable. Responses where no toolbar is injected (non-HTML, or HTML without a `</body>`) keep their original cacheability.
