/**
 * Console-side mirrors of the labeler's stored shapes (assessment-store.ts,
 * findings.ts, policy-resolver.ts, assessment-lifecycle.ts). Deliberately
 * redeclared rather than imported: those modules pull in D1/Workers types
 * that don't belong in a browser bundle, and the console's contract is
 * "what an authenticated operator API returns," which only needs to stay
 * shape-compatible with the store, not import it directly.
 */

export type AssessmentState =
	| "observed"
	| "verifying"
	| "pending"
	| "running"
	| "passed"
	| "warned"
	| "blocked"
	| "error"
	| "stale"
	| "cancelled";

/** The public assessment API's narrower state vocabulary (see
 * apps/labeler/src/public-assessment.ts's `derivePublicState`). Assessments
 * in a pre-decision or inconclusive-terminal internal state have no public
 * state at all — the operator console still shows them via `state`. */
export type PublicAssessmentState =
	| "pending"
	| "passed"
	| "warned"
	| "blocked"
	| "error"
	| "superseded";

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type FindingSource = "deterministic" | "capability" | "model" | "image" | "history";

export interface AssessmentRun {
	id: string;
	runKey: string;
	uri: string;
	cid: string;
	artifactId: string | null;
	artifactChecksum: string | null;
	state: AssessmentState;
	/** Precomputed by the server from `state` + supersession (see
	 * `derivePublicState`) — `null` for internal-only states. */
	publicState: PublicAssessmentState | null;
	trigger: string;
	triggerId: string;
	policyVersion: string;
	modelId: string | null;
	promptHash: string | null;
	publicSummary: string | null;
	supersedesAssessmentId: string | null;
	startedAt: string | null;
	completedAt: string | null;
	createdAt: string;
	isSuperseded: boolean;
}

/**
 * An operator-facing finding view. Unlike the public assessment API's
 * `PublicFindingView` (apps/labeler/src/evidence.ts), this carries
 * `privateDetail` and `evidenceRefs` — fields the labeler's public routes
 * never serialize. Components rendering a finding must keep the public and
 * private field groups visually distinct (see FindingCard) so this type
 * can't be reused for a public-facing view by accident.
 */
export interface OperatorFinding {
	id: string;
	assessmentId: string;
	source: FindingSource;
	category: string;
	severity: FindingSeverity;
	confidence?: number;
	title: string;
	publicSummary: string;
	privateDetail: string;
	evidenceRefs: readonly string[];
	affectedFiles?: readonly string[];
	affectedImages?: readonly string[];
	createdAt: string;
}

export interface IssuedLabel {
	val: string;
	cts: string;
	exp: string | null;
	neg: boolean;
	sequence: number;
}

export interface SubjectRecord {
	uri: string;
	cid: string;
	did: string;
	collection: string;
	rkey: string;
	observedAt: string;
	deletedAt: string | null;
}

export interface SubjectHistoryView {
	subject: SubjectRecord;
	assessments: AssessmentRun[];
}

/**
 * A row from the append-only `operator_actions` audit table (plan W9.2),
 * sanitized by the server's `serializeOperatorActionView` — the internal
 * replay fields (`idempotencyKey`, `requestFingerprint`, `resultJson`) are
 * never sent. Actor identity is the Cloudflare Access subject (`actorId`), not
 * a DID; humans carry `actorEmail`, service tokens carry `actorCommonName`.
 */
export interface OperatorAction {
	id: string;
	actorType: "human" | "service";
	actorId: string;
	actorEmail: string | null;
	actorCommonName: string | null;
	role: "admin" | "reviewer";
	action: string;
	subjectUri: string | null;
	subjectCid: string | null;
	labelValue: string | null;
	reason: string;
	createdAt: string;
}

export interface SystemStatusSnapshot {
	labelerDid: string;
	jetstreamConnected: boolean;
	pendingAssessments: number;
	/** Dead-letter backlog — the observable stand-in for discovery-queue depth,
	 * which the Queues API does not expose to the consumer Worker. */
	deadLetterDepth: number;
	/** The global ingestion kill-switch (spec §11.3). `pausedReason`/`pausedSince`
	 * are non-null only while paused. */
	automationPaused: boolean;
	pausedReason: string | null;
	pausedSince: string | null;
}

export interface Page<T> {
	items: T[];
	nextCursor?: string;
}

export type OperatorRole = "admin" | "reviewer";

/** The caller's verified identity from `/admin/api/whoami`, used only for
 * cosmetic button gating — the server (`guardMutation`) is the enforcement
 * boundary, so hiding a button never grants anything. */
export interface WhoamiIdentity {
	kind: "human" | "service";
	principal: string;
	sub: string;
	roles: OperatorRole[];
}

export type ReleaseEligibility = "eligible" | "pending" | "error" | "blocked";

/** Console mirror of registry-moderation's `ReleaseModeration` (redeclared, not
 * imported — the console renders what the effect-preview endpoint returns and
 * holds no policy logic). `applicableLabels` is opaque here; the UI shows the
 * summarized value lists. */
export interface ReleaseModeration {
	eligibility: ReleaseEligibility;
	reasonCodes: string[];
	blockingLabels: string[];
	stateLabels: string[];
	warningLabels: string[];
	suppressedLabels: string[];
	applicableLabels: { val: string; cid?: string; neg?: boolean }[];
	redacted: boolean;
}

export interface SupersededLabel {
	val: string;
	cid: string | null;
	sequence: number;
}

/** Server-derived preview of a proposed label action's official-client effect
 * (`GET /admin/api/labels/effect-preview`). */
export interface EffectPreview {
	labelEffect: string;
	scope: "cid-bound" | "uri-wide";
	supersedes: SupersededLabel[];
	before: ReleaseModeration | null;
	after: ReleaseModeration | null;
}

export interface EffectPreviewParams {
	uri: string;
	val: string;
	cid?: string;
	neg?: boolean;
}

/** A selectable label value plus its ceremony scope, for the action dialog's
 * menu. Presentation only — the server is the authority on what a reviewer may
 * issue (`guardMutation`), so this menu never gates anything. */
export interface IssuableLabel {
	val: string;
	scope: "cid-bound" | "uri-wide";
}

/** Body for `POST /admin/api/labels/{issue,retract}`. `idempotencyKey` is minted
 * client-side (ULID) per confirm-dialog open and reused across retries so a
 * network retry replays rather than double-issues. */
export interface LabelActionInput {
	uri: string;
	val: string;
	cid?: string;
	confirmation: string;
	reason: string;
	idempotencyKey: string;
}

/** The deterministic idempotent result returned by an issue/retract — no
 * `sequence` (assigned by a DB trigger post-commit; two replays must agree). */
export interface IssuedLabelDescriptor {
	actionId: string;
	val: string;
	uri: string;
	cid: string | null;
	neg: boolean;
	cts: string;
	effect: string;
}

/**
 * The active label state for a subject `(src, uri)` at a CID from
 * `GET /admin/api/subjects/:uri/labels?cid=` — the current stream winner per
 * value, including the manual/override labels that carry no `assessment_id` and
 * so never appear in the assessment-scoped label list. `active` already encodes
 * non-negated + unexpired + CID-applicable. */
export interface SubjectLabel {
	val: string;
	cid: string | null;
	active: boolean;
	neg: boolean;
	/** Whether the stream head was issued by automation — only automated heads
	 * are in the override's negatable set; a manual head unblocks via retract. */
	automated: boolean;
	cts: string;
	exp: string | null;
	sequence: number;
}

/** Body shared by the rerun and override-retract actions: a required reason, a
 * server-validated typed CID confirmation, and a client-minted idempotency key
 * (ULID) reused across retries so a network retry replays rather than repeats. */
export interface AssessmentActionInput {
	confirmation: string;
	reason: string;
	idempotencyKey: string;
}

/** Override body: adds the observed active automated block set, validated
 * server-side against live label state (a stale set is rejected). */
export interface OverrideActionInput extends AssessmentActionInput {
	negate: string[];
}

/** Idempotent rerun result — the new run + its immutable operator trigger. */
export interface RerunResult {
	actionId: string;
	runId: string;
	triggerId: string;
	uri: string;
	cid: string;
	cts: string;
}

export interface OverrideResult {
	actionId: string;
	uri: string;
	cid: string;
	negated: string[];
	issued: string[];
	cts: string;
}

export interface OverrideRetractResult {
	actionId: string;
	uri: string;
	cid: string;
	negated: string[];
	cts: string;
}

export interface OverrideEffectPreviewParams {
	uri: string;
	cid: string;
	negate: string[];
}

/** The emergency action vocabulary (admin-only). `takedown` is the URI-wide
 * `!takedown` on a release, package, or publisher; `publisher-compromised`
 * targets a publisher DID. */
export type EmergencyActionKind = "takedown" | "publisher-compromised";

/**
 * Body for the admin-only emergency endpoints (`POST /admin/api/emergency/*`).
 * The two typed ceremony fields — `subjectConfirmation` (the record rkey or the
 * publisher DID's final segment) and `intent` (the server-constant phrase) — are
 * both server-validated pre-signing and both fold into the request fingerprint.
 * The client mirrors the checks for UX; the server is authoritative.
 */
export interface EmergencyActionInput {
	uri: string;
	subjectConfirmation: string;
	intent: string;
	reason: string;
	idempotencyKey: string;
}

/** Body for the admin-only pause/resume endpoints (`POST /admin/api/automation/*`).
 * A required reason (folded into the audit row, the operational event, and — for
 * a pause — `automation_state.paused_reason`) and a client-minted idempotency key
 * reused across retries so a network retry replays rather than double-toggles. */
export interface AutomationToggleInput {
	reason: string;
	idempotencyKey: string;
}

/** Idempotent pause/resume result — the kill-switch's post-action state. */
export interface AutomationToggleResult {
	actionId: string;
	paused: boolean;
	reason: string;
	cts: string;
}

export interface ListAssessmentsParams {
	state?: PublicAssessmentState;
	cursor?: string;
	limit?: number;
}

export interface ListAuditLogParams {
	cursor?: string;
	limit?: number;
}
