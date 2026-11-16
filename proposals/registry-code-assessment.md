---
title: Registry release code assessment
type: rfc
status: proposed
authors:
  - Matt Kane (@ascorbic)
champion: Matt Kane (@ascorbic)
sponsor: null
discussions: []
created: 2026-11-16
---

# Registry release code assessment

## Summary

The plugin registry labeler assesses a release's package code as well as its listing text and images. The labeler reads the signed package bundle from the registry blob cache, verifies it against the release record's checksum, and unpacks it in memory without running it. It then matches the bundle and the release's `declaredAccess` against a ruleset of data-only detection rules. An optional model review of the code can add findings, but each one must cite lines in the bundle.

The scanning engine is public, in `apps/labeler`. Detection rules and the model review prompt are private data, kept in a separate repository and loaded at runtime from R2. A code finding holds the release for operator review. A code assessment that cannot finish marks the whole assessment as an error, so a scanner failure never passes a release.

## Problem and user case

The labeler gives a release `listing-passed` after it checks the listing's text, links and images. The model prompt in `apps/labeler/src/ai/prompts.ts` tells the model not to assess code. A release that passes can therefore still ship code that evaluates strings, imports Node.js built-ins that the sandbox does not provide, requests network access to any host, or quietly widens its access compared with the release before it. Operators find out only if someone reads the bundle.

Detection rules for an unfixed vulnerability are themselves sensitive. Publishing a rule that detects a specific undisclosed EmDash vulnerability discloses the vulnerability. The engine must therefore be able to run rules that never appear in this public repository.

## Example

The private repository holds a ruleset like the committed example, [`apps/labeler/code-rules/example-ruleset.json`](../apps/labeler/code-rules/example-ruleset.json):

```json title="ruleset.json"
{
	"schemaVersion": 1,
	"rulesetId": "emdash-example",
	"version": "2026-11-16.1",
	"rules": [
		{
			"kind": "ast",
			"id": "js-dynamic-evaluation",
			"category": "unsafe-code",
			"severity": "high",
			"confidence": 0.7,
			"summary": "The code evaluates strings as code with eval or the Function constructor.",
			"match": { "type": "identifier", "names": ["eval", "Function"] }
		},
		{
			"kind": "access",
			"id": "access-wildcard-host",
			"category": "access-risk",
			"severity": "high",
			"confidence": 1,
			"summary": "The release allows network requests to any host or to a whole top-level domain.",
			"check": { "type": "host-wildcard" }
		}
	]
}
```

A release whose `backend.js` is `export default { run: (code) => eval(code) };` and whose `declaredAccess` allows `"*"` produces two findings. The release receives `listing-review`, and the operator sees:

| Category      | Severity | Summary                               | Evidence                                                 |
| ------------- | -------- | ------------------------------------- | -------------------------------------------------------- |
| `unsafe-code` | high     | `js-dynamic-evaluation: The code …`   | `release.package:backend.js#L1C32:32-36`                 |
| `access-risk` | high     | `access-wildcard-host: The release …` | `release.declaredAccess.network.request.allowedHosts[0]` |

The assessment's `summary_json.codeIdentity` records the engine version, `emdash-example`, `2026-11-16.1`, and the SHA-256 of the ruleset text.

## Goals

- Assess every release's package code when the code assessment is configured.
- Keep detection rules and the review prompt out of the public repository.
- Never evaluate, import or run bundle code.
- Treat archive anomalies as findings, not crashes.
- Attach severity, confidence and file-and-offset evidence to every finding.
- Record which ruleset version assessed each release.
- Fail closed: a code assessment that cannot finish never passes a release.

## Non-goals

- A backward-looking scan of releases that are already published. That scan runs separately.
- Blocking releases automatically. Blocking stays an operator action (`listing-blocked`).
- Rules for specific EmDash vulnerabilities. They belong only in the private ruleset.
- Showing code findings, or the ruleset that produced them, in the public assessment output.
- Admin UI changes for severity.

## Detailed design

### Pipeline

The code assessment is a stage of the existing assessment Workflow. It runs after the image stage, only for release subjects, and only when `AssessmentWorkflowDependencies.codeAssessment` is configured. Each step is a durable `step.do`:

1. **Verify and project release package.** Re-verify the exact release record, then project only what the stage needs: the subject URI and CID, the version, the package artifact's `checksum` and blob CID, and `declaredAccess`. The projection excludes the publisher's package URL.
2. **Scan release package code.** Load the ruleset, read and verify the bundle, unpack it, look up the previous release when a rule needs it, and run the rules. The step result carries the findings and the ruleset identity.
3. **Review release package code.** Runs only when the ruleset has a `review` section. The step re-loads the ruleset and refuses to continue if its SHA-256 differs from the scan's, so one assessment never mixes two rulesets.

The stage combines the results into `{ status: "complete", result }`. Any thrown error is logged as `assessment_code_stage_failed` and becomes `{ status: "error", code: "code-assessment-unavailable" }`.

### Bundle intake

The labeler reads the bundle from the record-scoped registry blob cache (`REGISTRY_CUMULUS_ORIGIN` through the `REGISTRY_BLOB_CACHE` service binding), using the same guarded fetch, socket-pinned transport and redirect rules as display media. It never fetches the publisher's `artifacts.package.url`, which keeps the existing `neverFetch` invariant. A release whose package has no blob CID cannot be read, so its code assessment fails and the assessment is an error.

The labeler reads at most four times `MAX_BUNDLE_COMPRESSED_BYTES`, then checks the bytes against the record:

- When the record has a blob CID, its multihash must match the `checksum`.
- The SHA-256 multihash of the bytes must match the `checksum`.

A mismatch fails the stage. A verified bundle is gunzipped with `DecompressionStream`, capped at `MAX_BUNDLE_DECOMPRESSED_BYTES`, and parsed as USTAR in memory. The size and entry limits come from `@emdash-cms/registry-verification/bundle`, so the labeler and the publishing tools use the same values.

The tar parser records anomalies instead of throwing. Each anomaly becomes a `package-integrity` finding (rule IDs `bundle.<code>`), and severity depends on the code:

| Anomaly                                                                           | Severity |
| --------------------------------------------------------------------------------- | -------- |
| `path-traversal`                                                                  | critical |
| `symlink`, `hardlink`, `unsupported-entry-type`, `unsafe-path`, `duplicate-entry` | high     |
| size, count, gzip and archive-format limits                                       | high     |
| `unexpected-entry`, `missing-required-entry`, `invalid-text-encoding`             | medium   |

Duplicates are detected after Unicode NFC normalization and lowercasing. Expected entries are `manifest.json`, `backend.js`, `admin.js`, `README.md`, `icon.png` and `screenshots/*.{png,jpg,jpeg}`, with an optional leading `./`; `manifest.json` and `backend.js` are required. Anything else, including a `package/` directory, is `unexpected-entry`. Text files (`.js`, `.mjs`, `.json`, `.md`) are decoded as strict UTF-8.

JavaScript that acorn cannot parse as a module or a script produces a `bundle.unparseable-javascript` finding (medium), and the file's AST rules are skipped.

### Ruleset schema

Rulesets are JSON, validated strictly by `parseCodeRuleset` in `apps/labeler/src/code/ruleset.ts`. Unknown fields are rejected at every level.

| Field           | Type   | Constraint                                      |
| --------------- | ------ | ----------------------------------------------- |
| `schemaVersion` | number | `1`                                             |
| `rulesetId`     | string | `^[a-z0-9][a-z0-9._-]{0,63}$`                   |
| `version`       | string | Free-form, recorded in every assessment         |
| `rules`         | array  | At most 256 rules with unique `id`s             |
| `review`        | object | Optional model review configuration (see below) |

Every rule has `kind`, `id`, `category` (`unsafe-code`, `access-risk` or `package-integrity`), `severity` (`low`, `medium`, `high`, `critical`), `confidence` (0 to 1) and a `summary` of at most 400 characters. A rule never chooses an outcome; every finding recommends review.

`files` patterns are globs over bundle paths. A pattern must match `^[A-Za-z0-9._*/-]{1,128}$` and contain no empty, `.` or `..` segments.

**`ast` rules** match JavaScript syntax. `files` defaults to `["*.js"]`. `match` is one of:

- `{ "type": "identifier", "names": [...] }`: references to a name, not property keys, labels or import specifier names.
- `{ "type": "member", "object": "a.b", "properties"?: [...], "computed"?: boolean }`: property access on a base, including destructuring. With `computed: true` and no `properties`, the rule matches only access through a runtime-computed name.
- `{ "type": "call-object-key", "callee": "a.b", "keys": [...], "argumentIndex"?: 0-16 }`: an object literal key passed to a call.
- `{ "type": "import", "modules": [...] }`: static imports, `export … from`, `import()` with a literal, and `require()`. A trailing `*` matches a prefix.

**`text` rules** run a regular expression over files. `files` defaults to `["*.js", "manifest.json", "README.md"]`. `pattern` is at most 512 characters, and `flags` may contain only `i`, `m`, `s` and `u`.

**`access` rules** check the release record's `declaredAccess`. `check` is one of `host-wildcard`, `host-ip-literal`, `host-pattern` (with `pattern` and `flags`), `unrestricted-network` (network access without `allowedHosts`), or `declared` (a capability path of at most three segments is present).

**`access-diff` rules** compare `declaredAccess` with the previous release's, using `diffDeclaredAccess` from `@emdash-cms/plugin-types`. `escalationsOnly` defaults to `true`, and `paths` optionally limits the comparison to path prefixes. A first release produces no findings.

**`review`** configures the model review: `modelId`, `promptVersion`, `systemPrompt` (at most 32,000 characters), `files` (default `["*.js", "manifest.json"]`), `maxInputCharacters` (default 200,000, range 1,000 to 400,000) and `maxCompletionTokens` (default 2,048, range 256 to 8,192).

The engine returns at most 32 findings, highest severity first, with at most eight evidence references each. Evidence references use these forms:

- `release.package:<file>#L<line>C<column>:<start>-<end>`, with UTF-16 offsets.
- `release.package:entry[<n>]` for an archive entry.
- `release.declaredAccess.<path>`.
- `previous-release@<version>`.

### Ruleset loading

When `LABELER_CODE_RULESET_KEY` is set, the labeler loads that object from the `CODE_RULESET` R2 binding. The ruleset text may be at most 512 KB. A missing binding, a missing object, invalid JSON or an invalid ruleset fails the stage. The parsed ruleset is cached per isolate on `globalThis` for five minutes; after that the labeler re-reads the object and reuses the parse when the ETag is unchanged.

The assessment records `codeIdentity` in `summary_json`: `engineVersion`, `rulesetId`, `rulesetVersion`, `rulesetSha256`, and the review adapter identity when a review ran. The ruleset is not part of the run key, so a ruleset change does not re-run existing assessments.

### Previous release lookup

The aggregator exposes `GET /_internal/labeler/previous-release?uri=<release URI>` behind the existing reconciliation token. It returns `{ found: false }` when the release is not current, otherwise `{ found: true, previous }`. `previous` is the non-tombstoned release of the same package that sorts immediately below it by semantic version, or `null` for the first release. The labeler calls it only when the ruleset has an `access-diff` rule.

### Model review

The review prompt comes from the private ruleset. The labeler wraps it between public rules: before it, the rules that treat the `<code-input>` envelope as untrusted data; after it, the output rules. Files are XML-escaped and line-numbered inside `<file path="…">` elements. The request uses a JSON schema response, temperature 0 and seed 1. The prompt hash covers the full wrapped prompt.

The labeler rejects the whole review output when:

- `reviewedFiles` does not list every supplied file exactly once.
- A finding has no evidence, or an unknown category or severity.
- A citation names a file that was not supplied, a line range that is reversed, out of bounds or longer than 80 lines, or a quote that does not appear in the cited lines.

A rejected review fails the stage. Accepted model findings use the rule ID `model-review`.

### Policy and storage

`resolveAssessmentPolicy` accepts an optional `code` stage:

- A complete stage adds `coverage.code = "complete"`, its findings and `codeIdentity`.
- Any code finding gives the outcome `review` with `policy-finding`, like listing findings.
- A failed stage sets `coverage.code = "unavailable"`, which counts as missing required coverage. The outcome is `error`, labelled `listing-error`, with the reason codes `required-coverage-unavailable` and `code:<error code>`.

Without a `code` stage, coverage and outcomes are unchanged.

Findings are stored in the existing `findings` table. Migration `0012_finding_severity.sql` adds a nullable `severity` column, and the operator API returns it. `@emdash-cms/registry-moderation` adds `CODE_FINDING_CATEGORIES`, `FINDING_SEVERITIES` and `AssessmentFindingSchema`. `NormalizedModerationFindingSchema` still accepts listing categories only, so the listing model and the Clef adapter cannot emit code categories.

The public assessment output is unchanged. It maps code categories to `uncertain` with the canned summary, so rule IDs and rule text never appear publicly.

## Compatibility and migration

All changes are additive:

- The code stage is off unless `LABELER_CODE_RULESET_KEY` is set.
- Existing run keys and fingerprints do not change.
- The `severity` column is nullable, and existing rows keep `NULL`.
- The new aggregator route does not change existing routes.
- The `@emdash-cms/registry-moderation` and `@emdash-cms/registry-verification` additions are new exports.

Rollback is unsetting `LABELER_CODE_RULESET_KEY`. Assessments that already ran keep their findings and labels.

## Security and privacy

- **Bundle code is untrusted.** The labeler parses it with acorn and never evaluates or imports it. Tar parsing is in memory with fixed caps; paths never reach a filesystem.
- **Bundle bytes are verified.** Bytes come from the registry blob cache and must match the signed record's checksum before they are unpacked.
- **The publisher URL is never fetched.** The projection excludes it.
- **Private rules.** Rules and the review prompt live only in R2 and the private repository. The public repository contains the engine and a harmless example ruleset. Rule summaries reach the operator API but never the public output.
- **Rule regular expressions are trusted input.** They come from maintainers, are capped at 512 characters, and run over capped input under the Worker CPU limit. A catastrophic pattern fails the stage rather than passing the release.
- **Model output is untrusted.** Citations are checked against the supplied files before a finding is accepted.
- **Aggregator route.** The previous-release route is behind the reconciliation token and returns only `declaredAccess`, which is already public in the release record.

## Performance

The stage runs inside the assessment Workflow, not on a visitor request, so no logged-out route changes. Each release assessment adds:

- one blob-cache read of the bundle (at most a few megabytes),
- one R2 read per isolate every five minutes,
- one aggregator request when an `access-diff` rule is present, and
- one model call when `review` is configured.

acorn adds about 233 KB unminified (57 KB gzipped) to the labeler bundle. oxc-parser's WebAssembly build is about 2 MB and was not used.

## Failure handling

Any failure in the code stage, including an unreadable bundle, checksum mismatch, missing ruleset, aggregator error or rejected model output, gives `listing-error` with `coverage.code = "unavailable"`. The failure is logged as `assessment_code_stage_failed` with the subject and error message. Durable steps retry under the Workflow's normal retry policy. An operator can re-run the assessment after fixing the cause. Archive anomalies and unparseable JavaScript are findings, not failures.

## Verification

Tests in `apps/labeler/test` cover:

- the ruleset schema, including rejection of unknown fields, categories, severities, flags and path-like patterns, and R2 caching by ETag;
- tar anomalies: traversal, symlinks, hard links, duplicates, unexpected entries, pax headers, size limits and invalid gzip;
- each AST, text, access and access-diff rule, using the example ruleset;
- model review parsing, citation checks and envelope escaping;
- policy resolution with complete, findings and failed code stages; and
- the full Workflow: a clean pass, review with findings, archive anomalies, and fail-closed handling of an unreadable bundle and a checksum mismatch.

`apps/aggregator/test/listing-projection.test.ts` covers semver ordering of the previous release. `packages/registry-moderation/tests/inputs.test.ts` covers the finding schemas.

## Rollout and implementation

1. Deploy the aggregator so the previous-release route exists.
2. Apply the labeler D1 migration:
   ```bash
   pnpm --filter @emdash-cms/labeler exec wrangler d1 migrations apply <labeler database> --remote
   ```
3. Create an R2 bucket for the ruleset, for example `emdash-labeler-code-rules`, and upload the private ruleset from the private repository:
   ```bash
   wrangler r2 object put emdash-labeler-code-rules/rulesets/2026-11-16.1.json --file ruleset.json --content-type application/json --remote
   ```
4. Add the `CODE_RULESET` R2 binding to the labeler's private deployment configuration, and set `LABELER_CODE_RULESET_KEY` to the object key. `AGGREGATOR_RECONCILIATION` and `RECONCILIATION_TOKEN` must already be configured.
5. Deploy the labeler. New release assessments include the code stage.

To ship a new ruleset, upload it under a new key and change `LABELER_CODE_RULESET_KEY`, or overwrite the object. Isolates pick up an overwritten object within about five minutes. Validate a ruleset before uploading by running the private repository's checks against `parseCodeRuleset`.

## Alternatives

- **Rules in code.** Simpler to test, but every rule would be public, which rules out embargoed detections.
- **Rules as a Worker secret.** Secrets are size-limited and awkward to version. R2 gives a stable key, ETags and room to grow.
- **Fetching the publisher URL.** It is not content-addressed and is controlled by the publisher. The blob cache serves the verified blob.
- **oxc-parser or a WebAssembly parser.** Faster, but about ten times larger in the bundle.
- **Blocking on critical findings.** Blocking stays an operator decision, so a false positive cannot remove a listing.

## Drawbacks

- The labeler now depends on R2, the blob cache and the aggregator for every release. An outage in any of them gives `listing-error` until a re-run.
- Static rules are easy to evade with obfuscation; they catch careless or common patterns, not determined attackers.
- The model review adds cost and latency, and its citation check rejects the whole review when one citation is wrong.

## Open questions

- **URL-only packages.** Releases whose package has no blob CID fail the code stage. Should they be a finding instead, or should the labeler fetch the publisher URL under the guarded transport?
- **Ruleset changes and existing assessments.** The ruleset is not in the run key. Should a new ruleset version trigger re-assessment of current releases?
- **Previous release order.** The previous release is chosen by semantic version, not publish time. A backport such as 1.2.4 published after 2.0.0 is compared with 1.2.3.
- **Public lexicon.** The public assessment has no code coverage field or code categories, so code findings appear as `uncertain`. Should the lexicon gain them?
- **Admin UI.** The operator API returns severity, but the admin does not display it yet.
- **Manifest consistency.** The engine does not yet check that the bundle's `manifest.json` declares the same access as the signed record.
- **Model review failures.** Should one bad citation drop only that finding instead of failing the stage?
- **Anomalies and aggregator validation.** The aggregator may already reject some malformed bundles at ingest. Should those checks be shared?
- **`neverModel` fixture.** `PROHIBITED_ASSESSMENT_INPUTS_FIXTURE` lists `release.artifacts.package` as never sent to the listing model. The code review sends package files to a separate model. The fixture should say which stage it governs.
