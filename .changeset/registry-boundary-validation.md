---
"@emdash-cms/registry-client": minor
"emdash": patch
---

Validates aggregator-supplied `profile` / `release` records at the read-side trust boundary. `DiscoveryClient`'s `searchPackages`, `getPackage`, `resolvePackage`, `getLatestRelease`, and `listReleases` now parse the embedded signed records against the `com.emdashcms.experimental.package.profile` / `release` lexicons. A conforming record is returned as the typed lexicon shape; a non-conforming one is surfaced as `null` instead of being passed through.

This refines the return types from `unknown` to `PackageProfile.Main | null` / `PackageRelease.Main | null` (new exported `Validated*` view types). Callers must null-check. The registry install handler now fails closed when the aggregator returns a release record that does not conform to the lexicon.

Validation is structural only — the lexicon's `uri` format permits non-HTTP schemes, so UI rendering these URLs still applies its own scheme allow-list.
