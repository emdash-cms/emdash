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
 * Placeholder shape for the append-only `operator_actions` audit table
 * (plan W9.2) — that table doesn't exist yet, so the audit log route
 * renders an empty state rather than calling this through the client.
 */
export interface OperatorAction {
	id: string;
	actorDid: string;
	action: string;
	subjectUri: string | null;
	reason: string;
	createdAt: string;
}

export interface SystemStatusSnapshot {
	labelerDid: string;
	jetstreamConnected: boolean;
	pendingAssessments: number;
	discoveryQueueDepth: number;
	lastReconciliationAt: string | null;
}

export interface Page<T> {
	items: T[];
	nextCursor?: string;
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
