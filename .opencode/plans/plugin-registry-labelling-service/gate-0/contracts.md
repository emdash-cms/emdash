# Gate 0 Contract Ratification Proposal

Status: revised proposal for `W0.1` and `W0.2`. This is not a production Lexicon or protocol implementation. `W1.2` and `W1.5` remain blocked until the ratification points below are approved.

Companions: [implementation spec](../spec.md), [implementation plan](../implementation-plan.md), [moderation policy fixture](./fixtures/moderation-policy.json), and [moderation cases](./fixtures/moderation-cases.json).

## Scope

This proposal freezes public identifiers, public API shapes, label issuance authority, current-label reduction, subject applicability, and official-client moderation precedence. Standard label distribution continues to use `com.atproto.label.*`; no EmDash label-distribution Lexicon is proposed.

Subjects use the current experimental registry identifiers:

- Package: `com.emdashcms.experimental.package.profile`
- Release: `com.emdashcms.experimental.package.release`
- Publisher: a DID, optionally described by `com.emdashcms.experimental.publisher.profile`
- Reference labeller: `did:web:labels.emdashcms.com`

## Proposed Public Identifiers

| NSID                                                       | Kind        | Purpose                                                                    |
| ---------------------------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| `com.emdashcms.experimental.labeller.defs`                 | definitions | Shared public assessment, policy, coverage, label, and manual-action views |
| `com.emdashcms.experimental.labeller.getAssessment`        | query       | Fetch one immutable historical assessment by public ID                     |
| `com.emdashcms.experimental.labeller.getCurrentAssessment` | query       | Fetch effective assessment state for an exact release URI and CID          |
| `com.emdashcms.experimental.labeller.listAssessments`      | query       | Page through public assessments using bounded filters                      |
| `com.emdashcms.experimental.labeller.getPolicy`            | query       | Fetch the current machine-readable policy document                         |

The service also implements `com.atproto.label.queryLabels` and `com.atproto.label.subscribeLabels` without redefining them.

### Decision notice

No decision-notice repository record ships in v1. Labels provide the subscribable decision stream, public assessment queries provide explanations, and email remains the active publisher-notification channel. A future notice record can use a new experimental NSID without changing these queries.

### Well-known policy path

The permanent discovery URL is:

```text
https://labels.emdashcms.com/.well-known/emdash-labeler-policy.json
```

It returns the same policy object as `com.emdashcms.experimental.labeller.getPolicy`, with `Content-Type: application/json`. Responses use a representation-derived ETag and may be publicly cached for at most five minutes. The policy document is informational; stale policy data never changes whether a signed label is current.

## Shared Public Shapes

These shapes are inputs to `W1.2`. They intentionally use only fixed object properties, arrays, and other Lexicon-expressible structures. All datetimes are validated RFC 3339 `datetime` values.

### Assessment ID

Assessment IDs are opaque, case-sensitive `asmt_<26-character canonical uppercase ULID>` strings. Example: `asmt_01J2Q5Y7V8N9M0K1H2G3F4E5D6`. The ULID timestamp is allocation metadata only; clients use response timestamps for ordering and display.

### `publicAssessment`

```ts
interface PublicAssessment {
	id: string;
	src: string;
	subject: { uri: string; cid: string };
	artifact?: { id?: string; checksum: string };
	state: "pending" | "passed" | "warned" | "blocked" | "error" | "superseded";
	summary: string;
	coverage: {
		code: "complete" | "partial" | "unavailable";
		metadata: "complete" | "partial" | "unavailable";
		images: "complete" | "not-present" | "partial" | "unavailable";
		dependencies: "complete" | "partial" | "unavailable";
	};
	labels: Array<{
		val: string;
		active: boolean;
		issuedAt: string;
		expiresAt?: string;
	}>;
	policyVersion: string;
	assessmentSchemaVersion: number;
	model?: {
		provider: "workers-ai";
		modelId: string;
		promptVersion: string;
	};
	scannerVersions: Array<{ scanner: string; version: string }>;
	createdAt: string;
	completedAt?: string;
	supersedesAssessmentId?: string;
	reconsiderationUrl: string;
}
```

`artifact` and `model` are absent when unavailable. `scannerVersions` is sorted by `scanner` and contains at most one entry per scanner. `state: "superseded"` is derived only when a newer completed assessment names this assessment and owns the current pointer.

### `publicManualAction`

```ts
interface PublicManualAction {
	id: string;
	src: string;
	subject: { uri: string; cid?: string };
	type: "override" | "label-issue" | "label-retraction" | "emergency-takedown";
	summary: string;
	labels: Array<{ val: string; active: boolean; issuedAt: string; expiresAt?: string }>;
	createdAt: string;
}
```

This is a public summary, not the private operator reason or evidence record.

### Policy document

`fixtures/moderation-policy.json` is the canonical example. Its Lexicon-expressible shape is:

```ts
interface LabelerPolicyDocument {
	schemaVersion: 1;
	policyVersion: string;
	effectiveAt: string;
	labellerDid: string;
	assessmentSchemaVersion: number;
	supportedSubjects: {
		publisher: { kind: "did" };
		packageCollections: string[];
		releaseCollections: string[];
	};
	reasonCodes: Array<{ code: string; description: string }>;
	labels: Array<{
		value: string;
		category: "eligibility" | "automated-block" | "warning" | "manual-system";
		officialEffect: "pass" | "pending" | "error" | "block" | "warn" | "redact";
		subjectRules: Array<{
			subject: "release" | "package" | "publisher";
			cidRule: "required" | "optional" | "forbidden";
			issuanceModes: Array<"automated" | "reviewer" | "admin">;
		}>;
		locales: Array<{ lang: string; name: string; description: string }>;
	}>;
	overrideRule: {
		subject: "release";
		cidRule: "required";
		reviewerLabels: string[];
		requireSameSource: true;
		requireAtomicIssuance: true;
	};
	precedence: string[];
	publicApi: {
		baseUrl: string;
		policyUrl: string;
		getAssessmentNsid: string;
		getCurrentAssessmentNsid: string;
		listAssessmentsNsid: string;
		getPolicyNsid: string;
	};
	contact: { reconsiderationUrl: string; reconsiderationEmail: string };
	transparency: { modelOutputIsAdvisoryEvidence: true };
}
```

`issuanceModes` are subject-specific. An admin inherits reviewer capability, but the policy still lists `admin` where an action is admin-only. V1 advertises only deployed collections; clients do not infer wildcards.

## Endpoint Contracts

All four custom methods are unauthenticated `query` Lexicons served under `/xrpc/{NSID}`.

### `getAssessment`

Parameter: required `id`, maximum 64 bytes. Output: one `publicAssessment`.

Errors: `InvalidRequest`, `NotFound`, `RateLimitExceeded`.

`NotFound` does not distinguish never-existing, non-public, or retention-removed private data. A public summary referenced by an issued label remains resolvable.

### `getCurrentAssessment`

| Name  | Required | Constraint                  | Meaning                                         |
| ----- | -------- | --------------------------- | ----------------------------------------------- |
| `uri` | yes      | exact `at-uri`, no wildcard | Release record URI                              |
| `cid` | yes      | CID                         | Exact release record version being evaluated    |
| `src` | no       | DID                         | Labeller source; defaults to the endpoint's DID |

```ts
interface CurrentAssessmentView {
	src: string;
	subject: { uri: string; cid: string };
	current?: PublicAssessment;
	pending?: PublicAssessment;
	activeLabels: Array<{
		src: string;
		uri: string;
		cid?: string;
		val: string;
		cts: string;
		exp?: string;
	}>;
	override?: PublicManualAction;
}
```

`current`, `pending`, active labels, and override remain separate concepts. Active labels exclude a stream whose winner is negated, expired, or CID-inapplicable. Unknown URI/CID returns `NotFound`; a different `src` returns `UnsupportedSource` rather than an ambiguous empty response.

Errors: `InvalidRequest`, `NotFound`, `UnsupportedSource`, `RateLimitExceeded`.

### `listAssessments`

| Name     | Required | Constraint                        |
| -------- | -------- | --------------------------------- |
| `src`    | no       | endpoint DID only                 |
| `uri`    | no       | exact `at-uri`, no wildcard       |
| `cid`    | no       | CID; requires `uri`               |
| `state`  | no       | one public assessment state       |
| `limit`  | no       | integer 1-100, default 50         |
| `cursor` | no       | opaque string, maximum 1024 bytes |

Output: `{ assessments: PublicAssessment[], cursor?: string }`.

Ordering is `createdAt DESC, id DESC` with exclusive keyset pagination. The opaque base64url cursor encodes cursor version, final parsed `createdAt`, final `id`, and a hash of effective filters. A cursor is emitted only when another row exists. Changed filters, malformed data, or an unknown cursor version returns `InvalidCursor`, never page one.

Errors: `InvalidRequest`, `InvalidCursor`, `UnsupportedSource`, `RateLimitExceeded`.

### `getPolicy`

No parameters. Output: current `LabelerPolicyDocument`. Historical policies remain operational artifacts in v1 rather than a public query surface.

Error: `RateLimitExceeded`.

### Error codes

| Code                  | HTTP status | Meaning                                                                 |
| --------------------- | ----------- | ----------------------------------------------------------------------- |
| `InvalidRequest`      | 400         | Lexicon or cross-field validation failed                                |
| `InvalidCursor`       | 400         | Cursor is malformed, unsupported, or bound to different filters         |
| `UnsupportedSource`   | 400         | `src` differs from this deployment's labeller DID                       |
| `NotFound`            | 404         | Requested public assessment or exact subject is unavailable             |
| `RateLimitExceeded`   | 429         | Public rate limit exceeded; response should include `Retry-After`       |
| `InternalServerError` | 500         | Generic XRPC error for an unhandled server failure, not method-declared |

`com.atproto.moderation.createReport` returns `NotSupported` and persists nothing in v1.

## Moderation Evaluation Contract

`fixtures/moderation-cases.json` is executable input for `W1.5`.

### Inputs and accepted sources

The evaluator receives a parsed evaluation instant, exact publisher/package/release subjects and current CIDs, accepted labeller DIDs with `redact` flags, and label history. Missing `atproto-accept-labelers` is resolved to deployment defaults before evaluation; explicitly empty means no accepted sources and therefore no qualifying positive assessment.

Unaccepted sources are ignored. Every accepted source is reduced and evaluated independently. A source's valid override suppresses only that source's automated states. It never suppresses another accepted source's pending, error, automated block, warning, or manual action.

The `redact` flag controls presentation only. An accepted `!takedown` always blocks installation and marks its subject redacted only when that source has `redact: true`.

### Current label state

Current state has exactly the ATProto key `(src, uri, val)`. CID is not part of the stream key.

For each stream:

1. Parse every validated `cts` into an instant; never compare raw RFC 3339 text.
2. Select the event with the greatest parsed `cts`.
3. Treat semantically identical events at that instant as duplicate delivery. Semantic identity compares `ver`, `src`, `uri`, `cid`, `val`, `neg`, `cts`, and `exp`; signatures and transport metadata do not break a tie.
4. If non-identical events share the greatest parsed `cts`, mark that source's stream ambiguous. The official evaluator returns fail-closed `error` with `label-state-collision`; neither event wins.
5. If the winner has `neg: true`, the stream is inactive. A negation replaces the stream regardless of its CID.
6. Otherwise parse `exp`; the stream is inactive when `exp <= evaluatedAt`.
7. Apply the winner's CID metadata to the current subject only after current-state selection.

An expired winner does not reveal or reactivate an older event. An expired negation therefore leaves the stream inactive. Invalid `cts`/`exp` values are rejected before evaluation by label validation.

Subscription sequence and query pagination order are cursor/replay bookkeeping only. They never select current moderation state or resolve equal-`cts` collisions.

Subject issuance rules constrain what the reference issuer may sign; they do not alter the ATProto stream key. A consumer does not discard an accepted signed event before stream reduction merely because its CID would violate the current issuer policy. This lets a later CID-bearing negation safely retract an older URI-wide event and prevents legacy or buggy metadata from splitting one stream into two.

### Subject and CID applicability

- Release labels apply only to the exact release URI. A CID-bound winner applies only when its CID equals the current release CID; a URI-wide winner omits CID.
- Package labels apply only to the package URI. A CID-bound winner applies only to the current package CID; a URI-wide winner cascades to all package releases.
- Publisher labels target the publisher DID, omit CID, and cascade to all packages/releases from that DID.
- Automated eligibility, descriptive security, and warning labels are release-only and require release CID.
- `security-yanked` and release/package/publisher `!takedown` are URI-wide.
- `package-disputed` may be CID-bound to the current profile or URI-wide; this is a ratification proposal needed to exercise package-CID applicability without allowing manual issuance of automated descriptive values.
- CID mismatch makes the selected winner inapplicable; it does not restore an older same-stream event.

### Issuance authority and provenance

Standard labels do not prove whether an event came from automation or an operator. V1 therefore does not assign different consumer effects to the same descriptive value based on external action metadata.

- Automated descriptive security and warning values are release-only and automated-only.
- Reviewers cannot manually issue those values. They use `security-yanked` for a release or `package-disputed` for a package.
- Admins use `!takedown` and `publisher-compromised` for emergency/broad actions.
- `assessment-passed` permits automated and reviewer issuance. Its reviewer meaning is recognized only when the same source also has active exact-CID `assessment-overridden`.
- `assessment-overridden` is reviewer-issued and exact-CID.
- The issuer permits a reviewer `assessment-passed` only in one atomic action with `assessment-overridden` for the same release URI and CID. It never offers a standalone reviewer-pass operation.
- The issuer enforces allowed subject/mode combinations before signing. Public action metadata explains an action but never changes evaluator semantics.

### Per-source evaluation and aggregation

For each accepted source:

1. Apply manual blocks from that source.
2. Recognize an override only from active exact-CID `assessment-passed` plus `assessment-overridden` from that source.
3. Suppress that source's automated pending, error, and descriptive block values when its override is valid.
4. Otherwise classify active `assessment-error`, `assessment-pending`, automated blocks, pass, and warnings.

Aggregate unsuppressed source results in this order:

1. Any manual block: `blocked`.
2. Any label-state collision: `error`.
3. Any unsuppressed assessment error: `error`.
4. Any unsuppressed pending state: `pending`.
5. Any unsuppressed automated block: `blocked`.
6. No accepted source has an active pass or valid override: `blocked` with `missing-assessment-pass`.
7. Otherwise: `eligible`, with warnings from all accepted sources.

A pass or override from source A cannot bypass pending, error, or block from source B. An accepted source that has no relevant state does not veto a pass from another accepted source.

### Result fields

```ts
interface ReleaseModeration {
	eligibility: "eligible" | "pending" | "error" | "blocked";
	reasonCodes: string[];
	blockingLabels: string[];
	stateLabels: string[];
	warningLabels: string[];
	suppressedLabels: string[];
	redacted: boolean;
}
```

- `blockingLabels`: only active, applicable manual or automated labels whose policy effect is block/redact.
- `stateLabels`: active, applicable `assessment-pending` and `assessment-error` values. They never appear in `blockingLabels`.
- `warningLabels`: active, applicable warning values.
- `suppressedLabels`: same-source automated state/block values hidden by a valid override but retained for display.
- Label references in fixtures are ordered by source alias, subject, then value. Reasons follow aggregate precedence and are deduplicated.

## Decisions Requiring Matt's Ratification

1. Approve the five proposed NSIDs and no v1 decision-notice record.
2. Approve `asmt_<ULID>` public assessment IDs.
3. Approve exact URI+CID current lookup and `createdAt DESC, id DESC` keyset pagination.
4. Approve `UnsupportedSource` for a foreign `src` on this single-DID deployment.
5. Approve the Lexicon-expressible policy shape, fixed API properties, array reason/scanner entries, and permanent well-known path.
6. Approve `(src, uri, val)` current-state keys, parsed-instant `cts` ordering, and sequence-independent reduction.
7. Approve fail-closed `error` for a non-identical equal-`cts` collision.
8. Approve reducing accepted signed events before applying issuer-policy CID restrictions.
9. Approve expired winners never revealing older events, including expired negations.
10. Approve subject-specific issuance rules and automated release-only descriptive labels.
11. Approve that automated descriptive security/warning values cannot be manually issued in v1; reviewers/admins use the dedicated manual values instead.
12. Approve consumer override recognition solely from the same-source exact-CID pass/override pair, because standard labels cannot prove action provenance.
13. Approve that reviewer-issued pass is available only as one atomic pass/override pair, never as a standalone action.
14. Approve independent per-source evaluation and aggregate error > pending > automated block > positive-assessment resolution after manual blocks/collisions.
15. Approve accepted `!takedown` always blocking while `redact` controls presentation.
16. Approve `package-disputed` as warning/non-recommendation, not a direct-install block.
17. Approve optional CID binding for `package-disputed`; URI-wide disputes persist, while CID-bound disputes apply only to one package-profile version.
18. Approve manual release/package/publisher blocks taking precedence over overrides.
19. Approve `stateLabels` as the result field for pending/error labels, separate from `blockingLabels`.

No existing spec, plan, or production Lexicon was changed. `W1.2` and `W1.5` must not proceed from this proposal until the policy document and fixtures are ratified together.
