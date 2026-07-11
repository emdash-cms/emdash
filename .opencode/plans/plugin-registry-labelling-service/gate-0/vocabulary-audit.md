# Gate 0 Vocabulary Cutover Audit

Status: W0.3 audit complete. Canonical `security-yanked`, no-new-legacy emission, collision-safe ingest identity, and conditional Branch A were ratified on 2026-07-10. The production preflight remains an operator action.

Scope: tracked source, migrations, tests, documentation, generated contracts, and deployment configuration as of branch `feat/labeller-02-vocabulary-audit`. This audit is read-only. It does not establish production database state.

## Recommendation

Ratify `security-yanked` as the only value emitted by new code. Use the no-compatibility branch if the production preflight returns no legacy rows. Repository evidence makes that the likely result, but only the read-only production query below can establish it.

If legacy rows exist, do not rewrite signed `labels` history. First classify every row from its subject URI. Deploy a bounded consumer-only alias, reissue only active release-record rows as canonical `security-yanked`, and signed-negate their legacy values only after the compatibility floor is enforced. Quarantine package-profile, publisher-DID, malformed, and unknown-scope rows until an operator explicitly maps each action; never emit release-only `security-yanked` on those subjects.

The spelling cutover alone is insufficient. Current consumers do not implement the complete blocking policy, active-label semantics, accepted-source policy, subject cascading, or CID applicability. The history primary key is also not collision-safe for distinct valid labels sharing `(src, uri, val, cts)`. W1.1 should centralize vocabulary, while a forward schema migration plus W1.5, W4, and W5 must land before label ingest or issuance is enabled.

## Occurrence Inventory

### Legacy `security:yanked`

| Location                                                                                          | Reference                                        | Current role                                                              | Required future action                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/aggregator/migrations/0001_init.sql:187-230`                                                | `labels`, `label_state`, and example at line 191 | Schema accepts arbitrary `val`; the comment names the legacy value.       | Change the fresh-install comment. Do not edit signed persisted history. Add a mandatory forward collision-safe history migration before ingest.      |
| `apps/aggregator/src/routes/xrpc/searchPackages.ts:148-162`                                       | `ENFORCEMENT_FILTER_SQL`                         | Raw SQL blocks package-profile URIs with `!takedown` or the legacy value. | Replace with shared policy-driven subject evaluation. A temporary `IN (..., 'security:yanked')` alias is permitted only on the persisted-row branch. |
| `packages/registry-lexicons/lexicons/com/emdashcms/experimental/aggregator/searchPackages.json:8` | Query description                                | Generated-contract source documents the legacy spelling.                  | Use `security-yanked` and describe policy rather than a partial hard-coded pair. Regenerate types.                                                   |
| `packages/registry-client/src/discovery/index.ts:1-13`                                            | Module documentation                             | Says the aggregator enforces `!takedown` and the legacy value.            | Correct spelling and document that the client evaluates typed moderation state rather than trusting endpoint filtering alone.                        |
| `packages/core/src/api/handlers/registry.ts:1-39`                                                 | Install-flow documentation                       | Describes only the legacy yank as the label gate.                         | Describe and call the shared release-moderation evaluator.                                                                                           |
| `packages/core/src/api/handlers/registry.ts:791-808`                                              | `handleRegistryInstall`                          | Raw comparisons over package and release label arrays.                    | Replace both comparisons with one shared evaluation immediately before artifact download.                                                            |
| `packages/core/src/api/handlers/registry.ts:1462-1471`                                            | `handleRegistryUpdate`                           | Raw comparison over release labels only.                                  | Replace with the same shared evaluation used by install.                                                                                             |
| `packages/admin/src/components/RegistryPluginDetail.tsx:115-136`                                  | Release filtering                                | Claims aggregator filtering plus local defense in depth.                  | Consume typed eligibility; do not locally classify strings.                                                                                          |
| `packages/admin/src/components/RegistryPluginDetail.tsx:833-850`                                  | `YANKED_LABEL_VALUE`, `isYanked`                 | Defines and compares the legacy value and intentionally ignores `neg`.    | Delete after the shared evaluator is wired into the UI.                                                                                              |

No current runtime, migration, test, generated type, or public documentation occurrence of canonical `security-yanked` exists outside the labelling-service spec and implementation plan. The canonical value is therefore not currently recognized by shipped consumers.

### `!takedown` and redaction

| Location                                                                                          | Reference                  | Current behavior or gap                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/aggregator/migrations/0001_init.sql:191`                                                    | Schema comment             | `val` can store `!takedown`; no issuer or ingest path exists.                                                                                                                   |
| `apps/aggregator/src/routes/xrpc/searchPackages.ts:153-162`                                       | `ENFORCEMENT_FILTER_SQL`   | Filters only a package-profile URI, only when `trusted = 1`, and regardless of the request's accepted labelers or `redact` flag.                                               |
| `packages/registry-lexicons/lexicons/com/emdashcms/experimental/aggregator/searchPackages.json:8` | Query description          | Describes takedown filtering but does not encode accepted-source or redaction semantics.                                                                                        |
| `packages/registry-client/src/discovery/index.ts:101-114`                                         | `acceptLabelers` docs      | Forwards an opaque header and documents `;redact`; it neither parses the header nor interprets the response policy.                                                             |
| `apps/aggregator/src/routes/xrpc/router.ts:43-64`                                                 | CORS contract              | Allows `atproto-accept-labelers`, but incorrectly exposes that request header instead of `atproto-content-labelers`. The handler never parses either accepted DIDs or `redact`. |
| Core install/update handlers                                                                      | No comparison              | `!takedown` is not independently blocked. They rely on aggregator filtering that only exists on package search, not direct package/release reads.                               |
| Admin browse/detail                                                                               | No rendering or comparison | No redacted/takedown state is shown or blocked locally.                                                                                                                         |

### Verification and `verified`

There are two unrelated mechanisms that current code partially conflates:

1. `apps/aggregator/migrations/0001_init.sql:133-162` defines `publisher_verifications`, a table of signed `com.emdashcms.experimental.publisher.verification` records bound to subject handle and display name.
2. `apps/aggregator/src/records-consumer.ts:793-841` ingests those records. No read endpoint converts them into an ATProto label or hydrates a `verified` value.
3. `packages/admin/src/components/RegistryBrowse.tsx:168-188` and `RegistryPluginDetail.tsx:236-243` treat any raw label with `val === "verified"` as publisher verification.
4. `packages/admin/tests/components/RegistryPluginDetail.test.tsx:248-275` is the only focused verified-label fixture. It proves tooltip rendering, not source acceptance, negation, expiration, CID binding, or the verification-record validity rules.
5. `packages/registry-lexicons/lexicons/com/emdashcms/experimental/aggregator/defs.json:51-59,113-121` permits generic standard ATProto labels but does not define a `verified` vocabulary value.
6. `docs/src/content/docs/plugins/registry.mdx:20-29,75-85` and `docs/src/content/docs/reference/configuration.mdx:400-405` describe verification labels even though the current aggregator does not hydrate them.

`verified` must not become an eligibility shortcut. Coordinator confirmation is needed on whether publisher verification remains a separately evaluated registry record, becomes a typed non-moderation label under a distinct policy, or is removed from the admin label path. In every case, the current raw `verified` checks must be replaced.

### Generated contracts and client types

- `packages/registry-lexicons/lexicons/com/emdashcms/experimental/aggregator/defs.json:6-123` is the source contract. Package and release views have optional arrays of standard `com.atproto.label.defs#label`; `labels` is not a required field.
- `packages/registry-lexicons/lexicons/com/emdashcms/experimental/aggregator/listReleases.json:4-63` promises hard-enforcement filtering and hydrated labels that the current handler does not implement.
- `packages/registry-lexicons/lexicons/com/emdashcms/experimental/aggregator/getLatestRelease.json:4-36` promises the highest non-yanked release and `NotFound` when no eligible release exists; current code excludes only publisher tombstones.
- `packages/registry-lexicons/src/generated/types/com/emdashcms/experimental/aggregator/defs.ts:5-145` preserves the complete standard label shape through generated validation, including fields such as `src`, `uri`, `cid`, `val`, `neg`, `cts`, and `exp`. It adds no vocabulary or applicability policy.
- Generated `listReleases.ts` and `getLatestRelease.ts` preserve method shapes but not source descriptions, so source-Lexicon behavior claims need direct contract tests in addition to generated-file freshness checks.
- `packages/registry-client/src/discovery/index.ts:36-55` preserves those arrays in `ValidatedPackageView` and `ValidatedReleaseView`, but provides no active-label or eligibility helper.
- `packages/registry-client/tests/discovery.test.ts:33-326` covers transport, header forwarding, envelope validation, and embedded-record validation. It has no moderation-state fixture.
- `packages/registry-client/README.md:27-32` documents only opaque server-side hard-takedown filtering.

## Current Behavior and Gaps

### Database state model

`apps/aggregator/migrations/0001_init.sql:180-241` creates the following dormant label infrastructure:

- `labels` is intended as append-only history and retains `cid`, `neg`, `exp`, signature, version, trust, and receive time. Its primary key `(src, uri, val, cts)` is not a safe event identity: two distinct valid signed labels can share those four fields while differing in CID, negation, expiry, or signature. The second insert would collide and history would be lost.
- `label_state` projects one latest row per `(src, uri, val)` and retains that row's `cid`, `neg`, `exp`, and trust bit.
- The schema comment defines active as `neg = 0` and unexpired. The only runtime query using this rule is package search.
- `trusted` is copied onto each row. It can record ingestion provenance or the deployment-default trust snapshot at receipt time, but it must never decide request applicability. Request evaluation uses the current parsed accepted-DID policy, so a trust configuration change takes effect without rewriting history.
- No tracked source contains `INSERT`, `UPDATE`, or `UPSERT` statements for `labels`, `label_state`, or `labelers`. No seed or deployment data populates them.

Before any label ingest, add a forward migration to give each history event collision-safe identity. Preferred shape: a stable digest of the exact verified signed-label bytes as the primary/idempotency key, plus unique `(src, source_sequence, frame_index)` coordinates for subscription ingest. `subscribeLabels` sequence identifies a frame, and one frame may carry multiple labels, so `(src, source_sequence)` alone is not unique. A different event-coordinate primary key is acceptable only if every ingest and replay path proves the same per-label identity. Do not use `cts` as event identity. Projection ordering uses verified `(source_sequence, frame_index)` after `cts`; a replay lacking those coordinates must retain both same-`cts` events and quarantine an ambiguous state transition rather than silently choose by insertion order or digest.

The state key chooses one current label for `(src, uri, val)` while retaining its CID. Consumers still have to reject a CID-bound state row when its CID does not equal the current subject CID. Current search does not perform that check.

### Active, negated, expired, and CID-bound labels

Current behavior is inconsistent:

- Package search checks persisted `trusted = 1`, `neg = 0`, and a textual `exp > strftime(...)` comparison.
- Package search does not check `cid`, accepted source DID, or `redact`.
- RFC 3339 strings are not safely ordered as text, and SQLite date functions are permissive rather than RFC3339 validators. SQL inventories raw `exp` only. Application code must first validate strict RFC3339 syntax and then parse/compare the instant against one evaluation time. Equality is expired/inactive. New malformed-expiry labels are rejected before write. An already-persisted positive legacy row with malformed or ambiguous expiry is quarantined and held suppressive until disposition.
- Package search constructs only the package profile URI. Because future `security-yanked` is release-only, this filter cannot suppress a yanked release. A release label's URI does not equal the package profile URI.
- Core install/update raw-array checks use only `val`. A negated, expired, unaccepted, wrong-CID, or untrusted label would still block if hydrated.
- Admin `isYanked` deliberately mirrors that incorrect raw-value behavior.
- Admin `verified` checks likewise ignore source acceptance, negation, expiration, CID applicability, and the separate publisher-verification validity contract.
- Aggregator views currently return `labels: []` unconditionally, so the core/admin checks are normally inert.

The future shared evaluator must define an applicable active label as one whose source DID is in the current request's accepted set, whose latest state is not negated, whose application-validated strict RFC3339 expiry is absent or strictly later than the evaluation instant, and whose CID is absent for a URI-wide action or exactly matches the current subject CID. Persisted `trusted` may explain ingestion/default provenance but cannot add or remove a source from that request. Unknown values remain visible as data but have no official effect unless policy assigns one.

### Aggregator endpoint trace

| Endpoint           | Current implementation                                                                                          | Moderation consequence                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `searchPackages`   | `searchPackages.ts:36-162` applies the partial package-URI SQL filter, then `packageView` emits `labels: []`.   | Only dormant trusted package-level legacy yank/takedown state is filtered. Publisher scope, release scope, accepted sources, and redaction are absent. |
| `getPackage`       | `getPackage.ts:17-38` reads `packages` and calls `packageView`.                                                 | Direct reads ignore all labels and takedowns.                                                                                                          |
| `resolvePackage`   | `resolvePackage.ts:50-84` resolves a handle, reads `packages`, and calls `packageView`.                         | Same as `getPackage`.                                                                                                                                  |
| `listReleases`     | `listReleases.ts:22-104` selects every non-tombstoned release and calls `releaseView`.                          | No moderation filter, tombstone, hydration, or explanation.                                                                                            |
| `getLatestRelease` | `getLatestRelease.ts:25-66` trusts `packages.latest_version`, then falls back to highest non-tombstoned semver. | "Eligible" currently means only non-tombstoned. Positive assessment and every blocking label are ignored.                                              |
| View mapping       | `views.ts:120-163`                                                                                              | Package and release labels are always empty arrays.                                                                                                    |
| Request boundary   | `router.ts:43-117`                                                                                              | The accepted-labeler header is allowed but not parsed; no `atproto-content-labelers` response is produced.                                            |

### Registry client trace

`DiscoveryClient` forwards `acceptLabelers` on every request and validates response envelopes. It does not:

- Parse accepted labelers or the aggregator's actual content-labeler response.
- Filter active state.
- Evaluate publisher, package, and release subjects together.
- Require `assessment-passed`.
- Classify pending, error, blocking, warning, manual override, or redacted states.
- Verify hydrated label signatures.

Its `listReleases` and `getLatestRelease` comments promise yank-aware behavior that the aggregator does not implement. CLI `search` and `info` construct the client without accepted-labeler configuration (`packages/plugin-cli/src/commands/search.ts:48-58`, `info.ts:45-56`); `info` prints raw labels (`info.ts:98-102`) without explaining effect or active state.

### Core install, update, and update-check trace

- `handleRegistryInstall` resolves package and release views, then blocks only raw legacy yanks on package or release (`registry.ts:684-808`). It does not block `!takedown`, canonical yank, any descriptive security label, missing/pending/error assessment, or package/publisher cascades.
- Explicit-version installs page through `listReleases`, so they bypass any future latest-release filtering unless the handler performs the same shared evaluation.
- `handleRegistryUpdate` resolves a release and blocks only a raw legacy release yank (`registry.ts:1389-1471`). It does not load package/publisher state and has less defense than install.
- `handleRegistryUpdateCheck` trusts `getLatestRelease` and exposes an update without evaluating its moderation state (`registry.ts:1683-1744`). Failures are skipped, so an ineligible installed release also has no alert path.
- `packages/core/src/astro/routes/api/admin/plugins/registry/artifact.ts:293-353` independently resolves latest or explicit release media through `DiscoveryClient` and returns the declared URL without evaluating moderation. A stale or hand-built proxy URL could therefore retrieve media for a blocked/redacted explicit release unless this route shares the same policy or the aggregator returns a redacted tombstone.
- Focused core tests do not cover moderation. `packages/core/tests/unit/api/registry-handlers.test.ts:1-12` explicitly lacks update happy-path coverage; `registry-env-gate-handler.test.ts:47-67` supplies only `labels: []`.

The shared evaluation must run after exact release selection and again immediately before artifact download for both install and update. Update-check and installed-release alert paths must consume the same result type rather than infer eligibility from endpoint selection.

### Admin browse and detail trace

- Browse trusts aggregator search filtering and shows only a raw `verified` shield (`RegistryBrowse.tsx:151-204`). Its React Query key at lines 51-62 omits `config.acceptLabelers`, so changing accepted policy can reuse stale results.
- Detail's package query key at lines 100-107 also omits `config.acceptLabelers`. The release-list key includes it at lines 126-130.
- Detail removes only raw legacy yanks and hides every release if all returned releases match that string (`RegistryPluginDetail.tsx:115-178,833-850`). It does not surface pending/error/block reasons, warnings, source, CID, expiry, overrides, or reconsideration.
- There is no `RegistryBrowse` component test and no yanked/moderation test in `RegistryPluginDetail.test.tsx`.
- Server errors document only `RELEASE_YANKED` (`packages/admin/src/lib/api/registry.ts:674-692`), not the future eligibility states.

## Complete Official Blocking Policy

W0.2 owns executable fixtures and is authoritative if it differs from this audit. The spec currently requires the following evaluation shape:

1. Require an applicable active `assessment-passed` from an accepted labeler. Its absence is `pending`/unknown and blocks.
2. `assessment-pending` blocks temporarily. `assessment-error` blocks and explains an operational failure.
3. Block active automated security labels: `malware`, `data-exfiltration`, `credential-harvesting`, `supply-chain-compromise`, `critical-vulnerability`, `artifact-integrity-failure`, `invalid-bundle`, `undeclared-access`, and `impersonation`.
4. Block active manual `security-yanked` on a release.
5. Redact and block `!takedown` according to accepted-labeler `redact` policy. `!suspend` must follow the standard redaction contract where supported.
6. Block `publisher-compromised` across all packages and releases from the publisher.
7. Apply package and publisher labels at evaluation time without copying them onto release rows. `package-disputed` warns and prevents recommendation; direct-install blocking remains a ratification point.
8. Warning values (`suspicious-code`, `obfuscated-code`, `privacy-risk`, `misleading-metadata`, `low-quality`, `broken-release`) do not block alone, but official admin installation requires explicit warning consent.
9. An exact-CID action-backed `assessment-passed` plus `assessment-overridden` may override selected automated release blocks according to W0.2 fixtures. It never overrides `!takedown`, `security-yanked`, `publisher-compromised`, or broader manual package/publisher blocks.
10. A wrong-CID positive label never makes the current release eligible. A URI-wide manual action remains applicable across record edits until negated or expired.

## Production Persistence Evidence

Evidence that a database may exist:

- `docs/src/content/docs/plugins/registry.mdx:12-18,37-49` says the reference aggregator runs at `registry.emdashcms.com`.
- `apps/aggregator/wrangler.jsonc:1-21` names Worker `emdash-aggregator` and D1 database `emdash-aggregator`; the database is auto-provisioned on first deploy.
- `apps/aggregator/package.json:7-16` provides production deploy and remote migration commands.
- Git history contains the aggregator scaffold, ingest, read API, install integration, and Workers Builds fixes, consistent with deployment work.

Evidence against application-created label rows:

- The only label tables are the initial migration's dormant infrastructure.
- `views.ts:15-18` and `searchPackages.ts:12-15,148-152` explicitly say label hydration/ingest has not landed and the table is empty in the current slice.
- Exhaustive tracked searches found no writer for `labels`, `label_state`, or `labelers` and no seed data containing any moderation value.
- There is no configured labeler subscription, label queue, or labeler DID in current deployment configuration.

Evidence limitations:

- `wrangler.jsonc` intentionally omits `database_id` and production routes are configured at deploy time, so this checkout cannot identify or inspect the deployed D1 instance.
- Operators could have inserted rows manually or through untracked deployment tooling.
- Documentation proving a deployed aggregator does not prove which migrations ran or what rows exist.

Conclusion: persisted production label rows are unlikely, and application-produced legacy rows are especially unlikely, but production state is unknown until an authorized operator runs the read-only preflight.

## Safe Production Preflight

Run the following read-only SQL against each production/staging aggregator D1 database before W1.1 deploys. Do not run it against the labeler database. It returns counts first, followed by the matching rows without signature bytes.

```sql
SELECT
  'labels_history' AS storage,
  COUNT(*) AS total_rows,
  COALESCE(SUM(CASE WHEN val = 'security:yanked' THEN 1 ELSE 0 END), 0) AS legacy_rows,
  COALESCE(SUM(CASE WHEN val = 'security-yanked' THEN 1 ELSE 0 END), 0) AS canonical_rows
FROM labels
UNION ALL
SELECT
  'label_state' AS storage,
  COUNT(*) AS total_rows,
  COALESCE(SUM(CASE WHEN val = 'security:yanked' THEN 1 ELSE 0 END), 0) AS legacy_rows,
  COALESCE(SUM(CASE WHEN val = 'security-yanked' THEN 1 ELSE 0 END), 0) AS canonical_rows
FROM label_state;

WITH matching AS (
  SELECT
    'labels_history' AS storage,
    src,
    uri,
    cid,
    val,
    neg,
    cts,
    exp,
    trusted
  FROM labels
  WHERE val IN ('security:yanked', 'security-yanked')
  UNION ALL
  SELECT
    'label_state' AS storage,
    src,
    uri,
    cid,
    val,
    neg,
    cts,
    exp,
    trusted
  FROM label_state
  WHERE val IN ('security:yanked', 'security-yanked')
), uri_parts AS (
  SELECT
    *,
    CASE WHEN substr(uri, 1, 5) = 'at://' THEN 1 ELSE 0 END AS is_at_uri,
    CASE
      WHEN substr(uri, 1, 5) = 'at://' THEN instr(substr(uri, 6), '/')
      ELSE 0
    END AS authority_slash
  FROM matching
), authority_parts AS (
  SELECT
    *,
    CASE
      WHEN is_at_uri = 1 AND authority_slash > 1
      THEN substr(uri, 6, authority_slash - 1)
      WHEN is_at_uri = 0
      THEN uri
      ELSE NULL
    END AS candidate_did,
    CASE
      WHEN is_at_uri = 1 AND authority_slash > 1
      THEN substr(uri, 6 + authority_slash)
      ELSE NULL
    END AS path_after_authority
  FROM uri_parts
), parsed_parts AS (
  SELECT
    *,
    substr(candidate_did, 5) AS did_body,
    instr(substr(candidate_did, 5), ':') AS method_separator,
    instr(path_after_authority, '/') AS collection_separator
  FROM authority_parts
), fields AS (
  SELECT
    *,
    substr(did_body, 1, method_separator - 1) AS did_method,
    substr(did_body, method_separator + 1) AS did_identifier,
    substr(path_after_authority, 1, collection_separator - 1) AS subject_collection,
    substr(path_after_authority, collection_separator + 1) AS subject_rkey
  FROM parsed_parts
), screened AS (
  SELECT
    *,
    CASE
      WHEN substr(candidate_did, 1, 4) = 'did:'
        AND method_separator > 1
        AND did_method NOT GLOB '*[^a-z0-9]*'
        AND length(did_identifier) > 0
        AND did_identifier NOT GLOB '*[^A-Za-z0-9._:-]*'
      THEN 1
      ELSE 0
    END AS did_shape_candidate
  FROM fields
), classified AS (
  SELECT
    *,
    CASE
      WHEN is_at_uri = 0 AND did_shape_candidate = 1 THEN 'publisher_candidate'
      WHEN is_at_uri = 1
        AND did_shape_candidate = 1
        AND collection_separator > 1
        AND length(subject_rkey) > 0
        AND subject_rkey NOT GLOB '*[/?#]*'
      THEN CASE subject_collection
        WHEN 'com.emdashcms.experimental.package.release' THEN 'release_candidate'
        WHEN 'com.emdashcms.experimental.package.profile' THEN 'package_candidate'
        ELSE 'unknown'
      END
      ELSE 'unknown'
    END AS subject_scope
  FROM screened
)
SELECT
  storage,
  subject_scope,
  CASE WHEN is_at_uri = 1 THEN subject_collection ELSE NULL END AS subject_collection,
  src,
  uri,
  cid,
  val,
  neg,
  cts,
  exp,
  trusted
FROM classified
ORDER BY storage, subject_scope, src, uri, val, cts;
```

The SQL is only a conservative structural screen. It cannot validate full DID, AT URI, or ATProto record-key grammar. `release_candidate`, `package_candidate`, and `publisher_candidate` are not valid subjects yet. Before automatic canonical reissue, application code must use an ATProto parser/validator to require a fully valid DID authority, a plain publisher DID with no suffix, an AT URI with exactly authority/collection/rkey, the exact collection, and a record key satisfying the complete ATProto grammar, byte-length limit, and reserved `.`/`..` rejection. Any SQL candidate that application parsing does not strictly validate becomes `unknown` and remains quarantined/suppressive.

The SQL intentionally rejects some potentially valid percent-encoded DID forms as `unknown` rather than risk a false positive. Conversely, strings such as a trailing-colon DID or invalid rkey may pass the SQL shape screen; candidate status never authorizes migration.

Focused classifier fixtures:

| Subject                                                                   | SQL screen            | Required application result            |
| ------------------------------------------------------------------------- | --------------------- | -------------------------------------- |
| `did:plc:abc`                                                             | `publisher_candidate` | `publisher`                            |
| `did:plc:abc/path` or `did:plc:abc#fragment`                              | `unknown`             | `unknown`                              |
| `did::abc` or `did:PLC:abc`                                               | `unknown`             | `unknown`                              |
| `did:web:example.com:`                                                    | `publisher_candidate` | `unknown` (invalid trailing-colon DID) |
| `at://did:plc:abc/com.emdashcms.experimental.package.release/pkg:1.0.0`   | `release_candidate`   | `release`                              |
| `at://did:plc:abc/com.emdashcms.experimental.package.profile/pkg`         | `package_candidate`   | `package`                              |
| Missing authority, empty collection/rkey, extra path, or wrong collection | `unknown`             | `unknown`                              |
| Release rkey containing a space or `%`                                    | `release_candidate`   | `unknown`                              |
| Release rkey longer than the ATProto byte limit                           | `release_candidate`   | `unknown`                              |
| Release rkey `.` or `..`                                                  | `release_candidate`   | `unknown` (reserved)                   |

Interpretation:

- If both `legacy_rows` values are zero, choose Branch A.
- If either is nonzero, choose Branch B even when every projected legacy row is negated or expired. History replay and old projections still need an explicit compatibility decision.
- Only an application-validated `release_candidate` is eligible for automatic canonical reissue. Package/publisher candidates, failed application validation, and SQL `unknown` rows require explicit operator mapping and remain quarantined.
- SQL does not determine activity from `exp`. Application code treats a latest positive row as non-suppressive only when `exp` is strict RFC3339 and its parsed instant is at or before the single evaluation instant. Missing, malformed, or ambiguous expiry remains an active hold; a latest negation is inactive regardless of expiry.
- Any canonical row before the official signer exists is unexpected and requires provenance review before proceeding.

## Migration Branches

### Branch A: no persisted legacy rows

Recommended branch, contingent on the preflight:

1. Add no vocabulary compatibility alias and no legacy-row data migration.
2. Change all tracked examples and raw references to canonical `security-yanked` while centralizing the complete vocabulary.
3. Add the collision-safe forward history migration even on an empty database; it is a prerequisite for ingest, not legacy-data compatibility.
4. Add the shared evaluator and endpoint/client tests before issuing any production label.
5. Deploy the compatibility-floor component versions before enabling canonical label issuance.
6. Re-run the preflight immediately before issuance. A newly appeared legacy row switches the rollout to Branch B.

This follows the spec's explicit instruction not to carry compatibility without persisted data.

### Branch B: persisted legacy rows exist

1. Export/backup the affected D1 database and retain the preflight output as rollout evidence.
2. Apply the collision-safe forward history migration before enabling any subscriber, query backfill, or replay writer.
3. Inventory SQL candidates, then application-parse each raw subject and expiry. Record strict subject validity/scope, issuer, CID, current projected state, strict RFC3339 result/instant, and signature provenance.
4. Mark only application-validated `at://.../com.emdashcms.experimental.package.release/<valid-rkey>` rows as release-scoped. Quarantine package-profile URIs, publisher DIDs, malformed/ambiguous URIs or rkeys, SQL-only candidates, unknown collections, and unexplained/manual rows. Do not reinterpret them as release yanks and do not negate them until an operator approves a policy-valid replacement or explicit retirement.
5. Before changing vocabulary state, materialize fail-closed compatibility holds for every active quarantined row. A package hold suppresses the package and all of its releases; a publisher hold suppresses every indexed package/release for that DID. For malformed/unknown rows, preserve every subject suppressed by the pre-cutover query and suppress any indexed subject resolved by exact stored URI; an unresolvable row blocks exact-URI access and alias removal but must not create an unrelated ecosystem-wide block.
6. Deploy consumers that normalize only release-scoped `security:yanked` to the canonical release-yank policy class on read. Non-release/malformed rows use compatibility holds, not canonical normalization. The alias is consumer-only; no producer may emit the legacy value.
7. Enforce the compatibility floor below across the reference aggregator and supported official clients. Publishing packages does not upgrade deployed EmDash sites, CLIs, third-party aggregators, or cached admin bundles.
8. For each active, verified release-scoped legacy action, issue canonical `security-yanked` with the same release URI and intended CID scope. Keep the legacy positive active during the compatibility interval so old consumers retain their existing signal.
9. Only after the compatibility floor is enforced, issue a signed negation of that release-scoped legacy value. Canonical blocking must already be effective. Never emit canonical `security-yanked` on a package URI or publisher DID.
10. Let normal verified ingestion update `label_state`; do not hand-edit its projection unless a separately reviewed repair runbook is required.
11. Replay into a clean collision-safe history/projection and confirm identical blocked release subjects under the dual-read evaluator, including same-`cts` events.
12. Keep the dual-read rollout as the minimum rollback version. Rolling back below it after any legacy negation can fail open.
13. Remove the alias and compatibility holds only after all configured aggregators report zero active legacy state, every quarantined scope has an explicit replacement/retirement, full replay reproduces canonical state, and monitoring confirms no producer emitted the legacy value for the agreed retention window.

Quarantined-state behavior is explicit:

- Positive rows with no expiry or a strictly parsed future RFC3339 instant are active holds. A positive row with malformed or ambiguous expiry is also an active hold because expiry cannot be proved.
- Latest negated rows and positive rows whose strict RFC3339 instant is at or before the single evaluation instant remain quarantined for audit/mapping but do not suppress subjects. Exact equality is non-suppressive.
- A later valid positive can reactivate a hold according to collision-safe sequence/frame ordering.
- Manual retirement removes a hold only through an audited disposition; it does not rewrite signed history or emit release-only canonical vocabulary on a broader/malformed subject.

## Component Compatibility Floor

The current versions below are evidence from tracked manifests, not claims about every deployed installation. The implementation PR must replace each `TBD` with the first released version or deployed commit satisfying that class.

| Component class                                  | Current/target version marker                                 | Existing behavior                                                                                                                                                                    | Required compatibility-floor behavior                                                                                                                                                                                                                                                                                                                                                                                         | Safe after legacy negation?                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `A0` current/reference-old aggregator            | Private `@emdash-cms/aggregator@0.0.0`; current branch commit | Legacy package-search string filter only; direct package/release reads, latest selection, explicit release lists, and labels are not policy-complete.                                | Upgrade to `A1` before canonical issuance is relied upon.                                                                                                                                                                                                                                                                                                                                                                     | No.                                                                                           |
| `A1` reference aggregator                        | First deployed compatibility-floor commit: `TBD`              | New class.                                                                                                                                                                           | Verify before write; collision-safe history; current accepted-DID evaluation; canonical+legacy dual-read; application-validated subject/expiry; publisher/package/release expansion; block/redact search, package, resolve, list, latest, explicit-version, and media/artifact resolution consistently. For clients without typed tombstone support, omit blocked releases rather than returning an installable-looking view. | Yes for acquisition paths.                                                                    |
| `S0` already-installed EmDash/core/admin         | `emdash@0.28.1`, `@emdash-cms/admin@0.28.1`, client `0.3.2`   | Embeds its registry-client and raw legacy checks at build/install time. Updating npm packages or the reference Worker does not upgrade it. No complete installed-release alert path. | Either upgrade the installation to `S1` or require it to use an `A1` reference endpoint that fail-closes every latest/explicit/artifact path. Publish the minimum supported EmDash version.                                                                                                                                                                                                                                   | Acquisition can be safe through `A1`; installed-plugin alert/disable coverage remains absent. |
| `S1` policy-aware EmDash/core/admin              | First compatible EmDash/admin/client releases: `TBD`          | New class.                                                                                                                                                                           | Shared evaluator immediately before install/update artifact fetch, explicit-version parity, update-check/installed-release alerts, policy-keyed admin queries, and blocked/redacted artifact proxy.                                                                                                                                                                                                                           | Yes.                                                                                          |
| `C0` installed CLI/registry-client               | `@emdash-cms/plugin-cli@0.6.0`, registry client `0.3.2`       | No accepted-labeler option in current search/info commands; displays unclassified raw labels; no install/update command.                                                            | Upgrade to `C1` for accurate moderation display.                                                                                                                                                                                                                                                                                                                                                                              | No install bypass exists, but output is not trustworthy as policy explanation.                |
| `C1` policy-aware CLI/client                     | First compatible CLI/client releases: `TBD`                   | New class.                                                                                                                                                                           | Current accepted-DID policy, typed moderation result, canonical+bounded-legacy handling, and content-labeler reporting.                                                                                                                                                                                                                                                                                                      | Yes for its supported read-only paths.                                                        |
| Third-party/self-hosted old aggregator or client | Deployment-specific; no repository-controlled version floor   | Version and rollout are outside the reference deployment's control.                                                                                                                  | Operator attestation of `A1`/`S1` equivalent behavior or explicit exclusion from the supported compatibility set.                                                                                                                                                                                                                                                                                                             | Unknown until attested.                                                                       |

Safe rollout and rollback protections:

1. Land and deploy `A1` before using canonical labels for official enforcement. Exercise latest, explicit-version, list pagination, direct package/resolve, and artifact/media paths against both vocabulary values.
2. Release `S1` and `C1`, publish their exact minimum versions, and inventory managed installations. Self-hosted installations cannot be assumed upgraded; their operators must upgrade or accept unsupported status explicitly.
3. Under Branch B, issue canonical release labels while retaining active legacy positives. This overlap is the only interval in which both old legacy-aware and new canonical-aware consumers can remain blocked.
4. Do not signed-negate any legacy positive until the operator has enforced the declared floor: all reference endpoints are `A1`, supported managed EmDash installations are `S1` or pinned to `A1` fail-closed endpoints, and third-party compatibility has an explicit disposition.
5. Before negation, rollback to `A0`/`S0` remains possible only because legacy positives remain active, though their pre-existing policy gaps still exist. After the first negation, pin rollback to `A1`/`S1`; restore by replaying immutable history/projection, never by downgrading consumers.
6. Old installed sites have no automatic installed-plugin alert/disable upgrade path. Do not claim fleet-wide post-install protection until those sites run `S1`; `A1` only protects future acquisition requests that reach it.

Removal inventory (application parsing decides whether each positive row is suppressive):

```sql
SELECT
  src,
  uri,
  cid,
  neg,
  cts,
  exp,
  trusted
FROM label_state
WHERE val = 'security:yanked'
  AND neg = 0
ORDER BY src, uri, cts;
```

The removal procedure passes every raw `exp` through the same strict application validator. A valid RFC3339 instant exactly equal to or before the evaluation instant is inactive; a future instant or absent expiry is active. Invalid, date-only, timezone-less, space-separated, or otherwise ambiguous values remain active fail-closed holds and produce diagnostics. Historical legacy rows remain valid audit evidence after the compatibility alias is removed.

## Future PR Patch List

### W1.1: vocabulary cutover

- Add the ratified vocabulary to the shared moderation package selected by W1.5. No endpoint-local constants.
- `apps/aggregator/migrations/0001_init.sql`: correct the fresh-install example; preserve already-applied databases.
- Add a forward aggregator migration replacing history identity `(src, uri, val, cts)` with collision-safe event identity. Prefer signed-label digest/idempotency plus unique verified `(src, source_sequence, frame_index)` subscription coordinates; define deterministic duplicate, multi-label-frame, and same-`cts` conflict handling before ingest starts.
- `apps/aggregator/src/routes/xrpc/searchPackages.ts`: remove the legacy raw pair in favor of shared policy inputs, or add the bounded alias only under Branch B.
- `packages/registry-lexicons/lexicons/com/emdashcms/experimental/aggregator/defs.json`, `searchPackages.json`, `listReleases.json`, and `getLatestRelease.json`: correct source contract claims and describe typed moderation/redaction behavior. Regenerate `defs.ts`, `searchPackages.ts`, `listReleases.ts`, `getLatestRelease.ts`, generated indexes, and ambient registrations.
- `packages/registry-lexicons/tests/types.test.ts` plus aggregator read-contract tests: assert the regenerated package/release label shapes and the observable list/latest eligibility contract rather than relying on descriptions that generated TypeScript omits.
- `packages/registry-client/src/discovery/index.ts`, `README.md`, and `tests/discovery.test.ts`: correct vocabulary and add typed moderation-state fixtures.
- `packages/core/src/api/handlers/registry.ts`: remove all three legacy comparisons and route install/update through the shared evaluator.
- `packages/admin/src/components/RegistryPluginDetail.tsx`: remove `YANKED_LABEL_VALUE` and `isYanked`.
- Add changesets for affected published packages when implementation lands.

### W4: aggregator policy and hydration

- `apps/aggregator/src/routes/xrpc/router.ts`: parse accepted labelers once, set/CORS-expose `atproto-content-labelers`, and preserve missing versus empty policy.
- Add label ingest/projection code that validates payload shape and source, verifies signatures before any history/projection write, and preserves exact `src`, `uri`, `cid`, `val`, `neg`, `cts`, `exp`, signed bytes/digest, verified source sequence, and frame index.
- Treat persisted `trusted` only as receipt-time ingestion/default-policy metadata. Every request resolves current accepted DIDs independently; changing deployment trust must immediately affect old rows without rewriting them.
- Add one application-layer ATProto subject validator used by preflight migration and runtime policy. It must fully validate DID grammar, AT URI segmentation/collection, and record-key grammar, byte length, and reserved `.`/`..`; SQL candidates confer no validity.
- Add one strict application-layer RFC3339 syntax/instant parser. SQL stores/inventories raw expiry only. New malformed expiry is rejected; persisted malformed/ambiguous positive legacy expiry stays suppressive; strict instant equality is inactive.
- Under Branch B, add temporary compatibility holds for active quarantined package, publisher, malformed, and unknown-scope legacy rows. Hydration/filtering must apply their fail-closed suppression without converting them to canonical release vocabulary; negated/validly expired rows retain audit state without an active hold.
- `apps/aggregator/src/routes/xrpc/views.ts`: replace unconditional empty arrays with batched publisher/package/release hydration.
- `searchPackages.ts`, `getPackage.ts`, `resolvePackage.ts`, `listReleases.ts`, and `getLatestRelease.ts`: use shared subject expansion and evaluation. Search/redaction, direct tombstones, and latest eligible release must agree.
- `apps/aggregator/test/read-api.test.ts`: clear label tables between tests and add source, active/negated/expired, URI-wide/CID-bound, subject-cascade, redaction, and latest-selection coverage.
- Add request-header/CORS contract tests for absent, empty, malformed, repeated, unavailable, and `redact` accepted-labeler forms.
- Add workerd/D1 ingest security tests for invalid signatures, wrong DID/key, malformed/extra-field payloads, routine key rotation, one DID/key refresh on first verification failure, persistent failure after refresh, and unverifiable replay. Every rejection must prove zero history rows, zero projection writes, and no durable cursor advancement.
- Add collision/replay tests proving every label in one multi-label subscription frame receives distinct `(src, source_sequence, frame_index)` coordinates, exact redelivery deduplicates by digest, distinct valid same-`cts` labels both survive history, verified frame coordinates resolve projection order, and coordinate-less ambiguous replay is quarantined rather than overwritten.

### W5: client, core, CLI, and admin enforcement

- Add `evaluateReleaseModeration` and `ReleaseModeration` to the shared package and re-export/wrap it from registry-client without duplicating policy.
- Registry client must preserve response `atproto-content-labelers`, all label applicability fields, and assessment references; add full-label verification access separately.
- `handleRegistryInstall`, `handleRegistryUpdate`, and `handleRegistryUpdateCheck` must share evaluation over publisher, package, and exact release subjects. Explicit-version paths must not bypass it.
- `packages/core/src/astro/routes/api/admin/plugins/registry/artifact.ts` must fail closed for redacted/blocked exact releases so media retrieval cannot bypass direct-read policy.
- Add focused core handler tests for every eligibility outcome and prove rejection occurs before artifact fetch.
- `packages/admin/src/components/RegistryBrowse.tsx`: add accepted-labeler policy to the query key and render typed eligibility, not raw `verified`.
- `RegistryPluginDetail.tsx`: add accepted-labeler policy to the package query key; consume typed eligibility, warnings, issuer, summary, override, and reconsideration state.
- `packages/admin/tests/components/RegistryPluginDetail.test.tsx`: replace raw-yank assumptions with policy fixtures; add negation/expiry/CID/warning/override tests. Add browse tests.
- `packages/admin/src/lib/api/registry.ts`: expose localized server error mapping for pending, error, blocked, redacted, and warning-consent outcomes.
- `packages/plugin-cli/src/commands/search.ts` and `info.ts`: use configured official accepted-labeler policy and display the shared moderation result rather than unclassified raw labels.
- `docs/src/content/docs/plugins/registry.mdx`, `registry-client.mdx`, and `reference/configuration.mdx`: document canonical vocabulary, positive-assessment requirement, warning behavior, and actual accepted/content-labeler semantics after implementation.
- Add installed-release refresh/alert coverage for canonical yank, takedown, and newly blocking labels.

## Test Matrix

| Layer             | Required cases                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vocabulary        | Canonical value accepted; legacy rejected for issuance; legacy read alias present only in Branch B.                                                                                            |
| History identity  | Multi-label frame indices; exact-redelivery digest idempotency; distinct valid same-`cts` labels retained; verified `(sequence,index)` tie-break; coordinate-less conflict quarantine; replay. |
| State projection  | Newer positive, newer negation, out-of-order older positive, duplicate delivery, collision-safe replay from history.                                                                           |
| Expiry            | SQL raw preservation; strict app parsing of `Z`/offset and fractional/no-fraction forms; reject date-only, timezone-less, space-separated, malformed; exact-instant equality inactive.         |
| Source policy     | Missing header defaults, empty accepts none, multiple/repeated DIDs, unavailable DID, `redact` merge, correct `atproto-content-labelers`, and trust changes after ingest without row rewrites. |
| Ingest security   | Invalid signature, wrong key/DID, malformed or extra-field payload, rotated key after one refresh, failure after refresh, unverifiable replay, zero writes/cursor advance on rejection.        |
| CID applicability | Exact current CID, wrong CID, URI-wide action, package profile CID change, release CID change.                                                                                                 |
| Subject scope     | SQL candidate only; app DID/AT/rkey validation; trailing colon, suffix, spaces, percent, overlength, `.`/`..`, empty/extra path; quarantine holds; no broad canonical conversion.              |
| Eligibility       | Missing pass, passed, pending, error, every blocking security label, canonical yank, takedown, publisher compromise, warning-only, unknown label.                                              |
| Overrides         | Exact-CID automated-block override, newer assessment while override remains active, override retraction, inability to bypass manual release/package/publisher blocks.                          |
| Aggregator reads  | Search, package, resolve, release list, latest release, direct blocked tombstone, all-blocked package, cache `private, no-store`.                                                              |
| Registry client   | Envelope preservation, content-labeler response, shared evaluator parity, signed full-label retrieval, malformed label fail-closed behavior.                                                  |
| Core              | Latest and explicit install, latest and explicit update, update check, no artifact request before eligibility, stable localized error codes.                                                   |
| Admin             | Browse/detail query-key isolation, pending/error/block/warn UI, warning consent, issuer display, reconsideration, installed alert, Arabic RTL.                                                 |
| Compatibility     | Zero-row no-alias path; active/negated/expired legacy rows; `A0/A1`, `S0/S1`, and `C0/C1`; latest/explicit/artifact paths; canonical overlap before negation; rollback floor; alias removal.   |
| Verification      | Verification-record valid/expired/tombstoned/identity-drift states; raw `verified` label cannot grant eligibility or bypass moderation.                                                        |

## Rollback and Compatibility Removal

- Before legacy negation, canonical and legacy positives overlap. Rollback may retain legacy-aware consumers, but current `A0`/`S0` policy gaps remain and must not be described as complete enforcement.
- After the first legacy negation, rollback must not go below recorded `A1`/`S1` compatibility-floor versions. Package deployment alone is not evidence that installed sites upgraded.
- Under Branch B, retain the legacy read alias until the removal condition is met across every production projection and replay target.
- If migration or verification validation fails, pause issuance, retain dual-read and active legacy positives, restore/rebuild projections from immutable collision-safe signed history, and do not mutate historical `val` or signatures.
- Remove compatibility when active legacy state is zero, every quarantined non-release row has an explicit disposition, clean replay yields the same effective blocks, reference and supported consumer versions meet the floor, no producer emits legacy values during the ratified retention window, and coordinator evidence records those checks.

## Ratification Items

Coordinator/Matt confirmation is required for:

1. An authorized operator to identify every deployed aggregator environment and run the read-only preflight there.
2. Branch A versus Branch B based on that output. This audit recommends Branch A only conditionally.
3. Explicit replacement or retirement for each quarantined package, publisher, malformed, or unknown-scope legacy row. Automatic conversion is prohibited.
4. The W0.2 executable matrix, especially `package-disputed` direct-install behavior and exact manual-override interaction with pending/error states.
5. Whether publisher verification remains a separate signed record or becomes a defined non-moderation label. The current undocumented raw `verified` value should not be retained by accident.
6. The exact released versions/commits defining `A1`, `S1`, and `C1`, the supported old-installation floor, third-party attestation policy, and Branch B retention window before any legacy negation.

Ratification recommendation: approve the canonical vocabulary and no-new-legacy-emission rule now; approve the no-compatibility implementation only after the production preflight is attached to the coordinating PR.
