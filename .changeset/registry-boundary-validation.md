---
"@emdash-cms/registry-client": minor
"emdash": patch
---

Validates aggregator responses at the read-side trust boundary in `DiscoveryClient`. Two layers run:

- **Response envelope** (`uri`, `cid`, `did`, `slug`, `version`, …): `DiscoveryClient` now routes every call through `@atcute/client`'s schema-validating `.call()` against the aggregator method's output lexicon. Request params are validated too. A non-conforming envelope throws `ClientValidationError`.
- **Embedded signed `profile` / `release` records** (typed `unknown` by the aggregator lexicon because they are relayed verbatim from publisher repos under a different lexicon namespace): now `safeParse`'d against `com.emdashcms.experimental.package.profile` / `release`. A conforming record is returned as the typed lexicon shape; a non-conforming one is surfaced as `null` so one bad record doesn't fail an entire search page.

Refines the return types from `unknown` to `PackageProfile.Main | null` / `PackageRelease.Main | null` (new exported `ValidatedPackageView` / `ValidatedReleaseView` / `ValidatedSearchPackages` / `ValidatedListReleases` types). Callers must null-check. The registry install handler now fails closed when the aggregator returns a release record that does not conform to its lexicon.

Validation is structural only — the lexicon's `uri` format permits non-HTTP schemes, so UI rendering these URLs still applies its own scheme allow-list.
