# @emdash-cms/registry-client

## 0.2.0

### Minor Changes

- [#1126](https://github.com/emdash-cms/emdash/pull/1126) [`cf3c706`](https://github.com/emdash-cms/emdash/commit/cf3c706a65087696eb6cca5844b7668a50e4a090) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `emdash-plugin update-package`, a CLI command for editing an already-published plugin's registry record (license, authors, security contacts, name, description, keywords) without cutting a new release. Without `--yes` it prints a diff and exits without writing; with `--yes` it writes the updated record to the publisher's PDS using atproto's `swapRecord` precondition (concurrent writes surface as `STALE_RECORD` instead of silently overwriting each other) and bumps `lastUpdated`. Optional fields use a "manifest absent = no change" policy: removing a key from the manifest doesn't wipe the published value, matching `publish` semantics. Renaming a plugin via the manifest now surfaces a "looks like a rename" message listing the publisher's existing packages instead of a generic not-found, so publishers don't accidentally orphan releases under the old slug.

  The publishing client (`@emdash-cms/registry-client`) gains a `swapRecord` parameter on `putRecord` and `unsafePutRecord` for callers needing optimistic-concurrency writes.

## 0.1.0

### Minor Changes

- [#1112](https://github.com/emdash-cms/emdash/pull/1112) [`3756168`](https://github.com/emdash-cms/emdash/commit/37561682224447c7280648dc770ab408afc4186a) Thanks [@ascorbic](https://github.com/ascorbic)! - Validates aggregator responses at the read-side trust boundary in `DiscoveryClient`. Two layers run:
  - **Response envelope** (`uri`, `cid`, `did`, `slug`, `version`, …): `DiscoveryClient` now routes every call through `@atcute/client`'s schema-validating `.call()` against the aggregator method's output lexicon. Request params are validated too. A non-conforming envelope throws `ClientValidationError`.
  - **Embedded signed `profile` / `release` records** (typed `unknown` by the aggregator lexicon because they are relayed verbatim from publisher repos under a different lexicon namespace): now `safeParse`'d against `com.emdashcms.experimental.package.profile` / `release`. A conforming record is returned as the typed lexicon shape; a non-conforming one is surfaced as `null` so one bad record doesn't fail an entire search page.

  Refines the return types from `unknown` to `PackageProfile.Main | null` / `PackageRelease.Main | null` (new exported `ValidatedPackageView` / `ValidatedReleaseView` / `ValidatedSearchPackages` / `ValidatedListReleases` types). Callers must null-check. The registry install handler now fails closed when the aggregator returns a release record that does not conform to its lexicon.

  Validation is structural only — the lexicon's `uri` format permits non-HTTP schemes, so UI rendering these URLs still applies its own scheme allow-list.

## 0.0.1

### Patch Changes

- [#923](https://github.com/emdash-cms/emdash/pull/923) [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `@emdash-cms/registry-client`: atproto-aware client for the EmDash plugin registry. Three independent layers — credential storage (filesystem / env-vars / in-memory), publisher repo operations, and discovery against an aggregator. EXPERIMENTAL — pin to an exact version while RFC 0001 is in flight.

- Updated dependencies [[`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209), [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31)]:
  - @emdash-cms/registry-lexicons@0.1.0
