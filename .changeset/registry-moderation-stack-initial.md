---
"@emdash-cms/registry-moderation": minor
"@emdash-cms/registry-verification": minor
---

Initial release of the plugin-registry moderation stack.

- `@emdash-cms/registry-moderation`: ATProto signed-label parsing, encoding, and public-key verification; release moderation evaluation over both signed and aggregator-hydrated labels (package and publisher cascades, CID-bound labels, negation and expiry); the shared hard-block and warning label vocabularies; the `atproto-accept-labelers` / `atproto-content-labelers` negotiation headers; and `isModerationBlocking`, the canonical blocking predicate for enforcement consumers.
- `@emdash-cms/registry-verification`: runtime-neutral primitives (Node and workerd) for verifying plugin release artifacts — multihash checksums, SSRF-guarded artifact fetch, canonical tarball and bundle structure validation with a validated file inventory, and Sigstore build-provenance verification.
