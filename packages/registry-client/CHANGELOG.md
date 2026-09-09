# @emdash-cms/registry-client

## 0.5.0

### Minor Changes

- [#2892](https://github.com/emdash-cms/emdash/pull/2892) [`66aeecd`](https://github.com/emdash-cms/emdash/commit/66aeecd1feded23c2ee607b799500c390a04eb92) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds interactive package-profile setup for delegated plugin releases. `emdash-plugin release setup` now creates a missing profile or adds delegated-release settings to an existing valid profile before writing the GitHub Actions workflow. Run `emdash-plugin profile setup` to prepare only the profile.

  Interactive setup asks for the GitHub repository when it is absent from `emdash-plugin.jsonc`, lets you choose when releases require approval, and confirms the profile write. Non-interactive callers must pass `--yes` when a profile change is required.

  The release service returns `PACKAGE_PROFILE_REQUIRED` before accepting artifact uploads when the signed profile is missing, lacks delegated-release settings, or names a different GitHub repository. Existing release intents also terminate with an actionable reason if their authoritative profile becomes invalid.

- [#2849](https://github.com/emdash-cms/emdash/pull/2849) [`52fffdc`](https://github.com/emdash-cms/emdash/commit/52fffdc3556396f48a5320a0213da1a03337f642) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `DirectPdsClient.getPackageRepository()` for reading a package profile and every package release from one proof-verified AT Protocol repository export.

  Use the method when authorization or version selection requires a complete signed package snapshot:

  ```ts
  const { profile, releases } =
  	await directPdsClient.getPackageRepository("gallery");
  ```

  The client verifies the repository commit signature, record blocks, and complete Merkle search tree before returning records. Unsigned `repo.getRecord` and `repo.listRecords` envelopes cannot substitute or omit package data. Repository exports use the client's `maxResponseBytes` limit, which defaults to 5 MiB, and a missing export reports `REPOSITORY_NOT_FOUND`.

- [#2747](https://github.com/emdash-cms/emdash/pull/2747) [`3b124f2`](https://github.com/emdash-cms/emdash/commit/3b124f23126fead8884884b9f3d53e3be5d41bd3) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds typed clients for the experimental delegated release service. `ReleaseServiceClient` submits, polls, and cancels GitHub OpenID Connect release intents; manages publisher workload policies and retained delegation; and lets publishers check whether profile-listed approvers have an active passkey and inspect publisher-scoped audit events through a publisher session. `ReleaseServiceOperatorClient` exposes the Cloudflare Access status and sanitized audit, sharded publisher and approver inventory, pause, suspension, revocation, cancellation, reconciliation, resumable encryption-key rotation, Workflow-backed fleet verification, audited key retirement, encrypted R2 archive, and fail-safe publisher restore and abort operations.

  `ReleaseServiceClient` can request, poll, list, and confirm GitHub workflow connections. The first permanent release run records GitHub's signed repository, workflow, ref, and environment as a pending request and returns a browser approval URL. The publisher must confirm those details before the service creates a workload policy. Tag-based connections can cover the current tag or all version tags while keeping the repository and workflow path exact.

  Both clients validate response envelopes and return stable `ReleaseServiceError` codes with retry metadata. Mutation helpers require idempotency keys, and workload polling requests a fresh token from the configured provider for each call.

  The plugin CLI adds `emdash-plugin release dry-run`, `release submit`, `release status`, and `release cancel` for GitHub Actions jobs. The first `release submit` requests browser approval for the permanent workflow and waits for confirmation before creating an intent. Dry-run verifies existing workload admission without creating a connection request, intent, consuming rate budget, or reserving a version. The commands request audience-bound OIDC tokens from the runner, support JSON output, and use the GitHub run identity as the default idempotency key where a mutation occurs.

  Delegated submissions use a URL-source release record: each package or listing-image artifact supplies a checksum-bound HTTPS URL and no blob. The service stages and uploads those bytes through the publisher's delegation, then creates a blob-only release record. Submit and dry-run reject mixed or blob-backed source inputs before requesting GitHub OIDC.

  Interactive `release delegate`, `revoke`, `workload`, `enrol`, `approve`, and `reject` commands print validated browser handoffs. Publisher application sessions, OAuth credentials, and passkey assertions remain at the release-service origin instead of entering the terminal process.

- [#2749](https://github.com/emdash-cms/emdash/pull/2749) [`920e1f3`](https://github.com/emdash-cms/emdash/commit/920e1f3fe6a7c7bf725c85e26f81e588e1201243) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `emdash-plugin release setup` to create the permanent GitHub Actions workflow for delegated plugin releases. The generated workflow builds and attests the plugin, waits for first-run browser authorization, and uploads its exact bundle and provenance through GitHub OIDC before publishing.

  `ReleaseServiceClient.uploadReleaseArtifact()` supports custom workflows that need to stage checksum-bound bundle, image, or provenance bytes. Existing URL-source `release submit` workflows remain supported.

- [#2848](https://github.com/emdash-cms/emdash/pull/2848) [`e0e60ba`](https://github.com/emdash-cms/emdash/commit/e0e60ba17b93d2022411afb8a3187c08e5142c18) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds publisher-created workflow connection invitations to delegated releases. First-time or unmatched GitHub workflows must use a package-bound, single-use invitation before they can request publisher approval; connected workflows continue without one.

  Create the invitation in the publisher dashboard or with `createWorkflowConnectionInvitation()`, then save its value as the repository's `EMDASH_CONNECTION_INVITATION` GitHub Actions secret. The generated release workflow passes this secret to the release Action automatically. Custom workflows can pass `invitationToken` to `requestWorkflowConnection()`, and publishers can reject pending requests with `rejectWorkflowConnection()`.

- [#2746](https://github.com/emdash-cms/emdash/pull/2746) [`c7b6fdf`](https://github.com/emdash-cms/emdash/commit/c7b6fdfd1f5dd9a168f5d0f6bfa9b7b9ff343145) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `DirectPdsClient` for reading package profiles and releases with AT Protocol repository proofs, and updates experimental decentralized registry installs and updates to verify current signed records directly from the publisher's PDS.

  #### Aggregator record integrity

  Install and update reject aggregator-supplied profile or release metadata whose URI or CID does not match the publisher's signed records. The server returns `AGGREGATOR_RECORD_MISMATCH` before fetching the artifact or requesting consent.

  #### Publisher identity display

  The admin treats handle resolution as an advisory identity signal. It keeps the install button disabled while attempting to resolve the package DID back to a handle, then blocks installation when `resolveDidToHandle()` conclusively returns `"invalid"`. An indeterminate result caused by a network failure, unsupported DID method, or missing handle displays the publisher DID and does not block installation.

  Install and update trust the publisher DID and the signed repository proofs for the profile and release records. A handle is display metadata and is not an authorization or record-integrity input.

  #### Provenance and release policy

  The installer applies the signed profile's release policy, independently fetches and verifies supplied Sigstore/SLSA provenance, and binds moderation labels to the exact profile or release CID. Missing required provenance and any supplied provenance that is unavailable, malformed, mismatched, or unsupported block installation and updates. Artifact checksums, archive paths, bundle limits, manifest identity, and version use the same verification rules as the registry release tooling.

  The verification package also exports `inspectPackageReleaseRecords` for validating signed records and policy before artifact and provenance evidence is available.

  Registry install and update consent now show the exact verified profile and release CIDs, signed publisher policy, and provenance status. Install consent uses permissions and MCP tools read from the verified bundle rather than the aggregator's record copy.

  Install, update, and delegated-release verification require lowercase base32 multibase `sha2-256` multihashes for package artifacts and provenance documents. The plugin CLI already produces this format. The authenticated image-artifact proxy still accepts legacy bare hexadecimal SHA-256 checksums for display-only images.

## 0.4.0

### Minor Changes

- [#2765](https://github.com/emdash-cms/emdash/pull/2765) [`9d92b55`](https://github.com/emdash-cms/emdash/commit/9d92b55b0c6b1e8d0506ea11887f18738989c414) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates plugin publishing to host package bundles, icons, banners, and screenshots as blobs on the publisher's Personal Data Server by default. Run `emdash-plugin publish` from the plugin directory; the CLI builds the bundle, checks the stored OAuth grant, uploads the artifacts, and writes CID-bound checksums into the release record.

  Existing scripts can keep externally hosted package bundles with `emdash-plugin publish --url <https-url>`. The CLI still downloads that URL to validate and hash the served bytes. Listing images are uploaded as publisher blobs on both paths.

  The experimental aggregator release envelope replaces `mirrors` with typed `artifactCaches`. The field is optional during rolling upgrades, and updated clients treat an omitted field as an empty cache list. A record-scoped cache descriptor supplies its service endpoint; clients derive `/r/{did}/{collection}/{rkey}/{recordCid}/{blobCid}` so cache admission is bound to the exact release revision.

  Install and update verify raw cache, PDS, and external fallback bytes against the signed checksum and blob metadata. The authenticated image proxy may serve a transformed record-scoped cache rendition; if that cache is unavailable, it falls back to checksum-verified PDS or external bytes. Listing images remain capped at 1 MiB.

  Sites must upgrade EmDash before installing a release whose package artifact is available only as a PDS blob. Older EmDash versions require an external package URL.

  #### What should I do?

  Remove `--artifact-base-url` from publish scripts and stop pre-uploading listing images. The CLI rejects the removed option with migration guidance. Replace any experimental `releaseView.mirrors` access with `releaseView.artifactCaches ?? []`. If an existing granular login reports `MISSING_BLOB_SCOPE`, run `emdash-plugin logout` and log in again to grant `blob:application/gzip` and `blob:image/*`.

- [#2647](https://github.com/emdash-cms/emdash/pull/2647) [`e3ad082`](https://github.com/emdash-cms/emdash/commit/e3ad0823121704c508cd104783a59fccd3f6a44e) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds signed-label policy and listing-status support to the plugin registry client. Registry requests use the aggregator's required listing policy with an optional accepted-labeler declaration, and withdrawn releases are excluded from install and update results.

  The EmDash admin waits for a fresh listing-policy response before rendering registry metadata, uses the approved author name or publisher DID instead of a mutable handle, and does not request media for an unapproved release. Install, update, and media-proxy checks enforce listing withdrawal independently from the existing plugin-code and capability checks.

  Registry artifact downloads and proxied media connect only to the public IP addresses validated for each URL, preventing DNS changes between validation and connection from reaching private services.

### Patch Changes

- Updated dependencies [[`9d92b55`](https://github.com/emdash-cms/emdash/commit/9d92b55b0c6b1e8d0506ea11887f18738989c414), [`6178888`](https://github.com/emdash-cms/emdash/commit/61788888bf5933e2a9ac310a931f1c241fa63878)]:
  - @emdash-cms/registry-lexicons@0.4.0
  - @emdash-cms/registry-moderation@0.1.0

## 0.3.4

### Patch Changes

- Updated dependencies [[`07c9f21`](https://github.com/emdash-cms/emdash/commit/07c9f210db300803f49ecf2b8a18fe173e459a28)]:
  - @emdash-cms/registry-lexicons@0.3.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`7c5de08`](https://github.com/emdash-cms/emdash/commit/7c5de08f6370ea88500b7ec425d58b2c82443260)]:
  - @emdash-cms/registry-lexicons@0.2.0

## 0.3.2

### Patch Changes

- [#1447](https://github.com/emdash-cms/emdash/pull/1447) [`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `@atcute` peer dependency warnings on install ([#1435](https://github.com/emdash-cms/emdash/issues/1435))

  Installing EmDash pulled in mismatched `@atcute` package versions, so `pnpm install` / `npm install` reported unmet peer warnings for `@atcute/identity` and `@atcute/lexicons`. The bundled `@atcute` dependencies are now aligned on v2 and installs are clean. If your project also depends on `@atcute` packages directly, note they have moved to v2 (`@atcute/client` 5, `@atcute/lexicons` 2, `@atcute/atproto` 4, `@atcute/oauth-node-client` 2).

- Updated dependencies [[`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b), [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4)]:
  - @emdash-cms/registry-lexicons@0.1.1

## 0.3.1

### Patch Changes

- [#1319](https://github.com/emdash-cms/emdash/pull/1319) [`69bdc97`](https://github.com/emdash-cms/emdash/commit/69bdc97e3e4b69a111b3e5210900e23f35134f8d) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix `require is not defined` crash on every EmDash API route under `astro dev` on Cloudflare Workers ([#1292](https://github.com/emdash-cms/emdash/issues/1292)).

  `@emdash-cms/registry-client` listed `semver` (CommonJS) in `dependencies`, which the build externalizes -- so consumers loaded a nested CJS copy. Vite's SSR module runner (workerd) evaluates modules with no `require` binding, so semver's internal `require()` threw and took down any route whose import graph reached registry-client (schema, plugins, env compatibility checks). semver is now bundled into the ESM output, so nothing CommonJS reaches the worker.

## 0.3.0

### Minor Changes

- [#1238](https://github.com/emdash-cms/emdash/pull/1238) [`60c0b2e`](https://github.com/emdash-cms/emdash/commit/60c0b2eeab7726471b313d0c453de82df1e08558) Thanks [@ascorbic](https://github.com/ascorbic)! - Registry plugins can now declare environment requirements. A plugin's manifest may set a release-level `requires` block (e.g. `{ "env:emdash": ">=1.0.0", "env:astro": ">=4.16" }`), which is published into the release record. When browsing a registry plugin, the admin compares those constraints against the running EmDash and Astro versions: if the host doesn't satisfy them, it shows a compatibility warning and disables the Install button. The server enforces the same check on install and update, refusing an incompatible release with `ENV_INCOMPATIBLE` so the gate can't be bypassed.

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
