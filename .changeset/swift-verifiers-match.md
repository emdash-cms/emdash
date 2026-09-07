---
"@emdash-cms/registry-verification": minor
---

Adds optional artifact digest candidates to `GitHubProvenanceVerifier`, allowing callers that compute several supported digest algorithms in one isolated artifact fetch to verify the digest selected by a signed SLSA provenance subject.

Existing callers can continue passing only `artifactDigest`. Successful results return the candidate that matched the signed subject.

Fixes `@emdash-cms/registry-verification` when it is rebundled into an Astro Cloudflare application, preventing requests from failing during Worker startup.

Adds `@emdash-cms/registry-verification/records` for Worker callers that supply an explicit `ProvenanceVerifier`. The runtime-neutral entry does not load the Node-oriented default Sigstore verifier, while the package root keeps the existing default-verifier behavior.

Fixes `@emdash-cms/registry-verification` when it is rebundled into an Astro Cloudflare application, preventing requests from failing during Worker startup.
