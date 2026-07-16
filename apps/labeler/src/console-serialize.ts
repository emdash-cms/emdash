/**
 * Operator-console wire serializers (plan W9.3): stored rows → the JSON shapes
 * the console's `createFetchClient` consumes (mirrored in
 * `console/src/api/types.ts`). The inverse of `evidence.ts`'s public boundary —
 * here we deliberately **include** the operator-only fields (`privateDetail`,
 * `evidenceRefs`, `modelId`/`promptHash`, label negations), because every
 * `/admin/api/*` route is Access-edge-gated and per-request reviewer-gated
 * (spec §19.2: private evidence "Access is limited to reviewer/admin roles").
 *
 * The one non-privacy exclusion is the audit view, which drops the internal
 * replay machinery (`idempotency_key`, `request_fingerprint`, `result_json`):
 * those are `commitMutation` plumbing, not evidence, and never displayed.
 *
 * Wire types are redeclared here rather than imported from the console (which
 * pulls in browser/React types); the two sides stay shape-compatible, with
 * `console/src/api/types.ts` as the shared truth.
 */

import type { OperatorRole } from "./access-auth.js";
import type { AssessmentState, PublicAssessmentState } from "./assessment-lifecycle.js";
import type {
	AssessmentFinding,
	AssessmentIssuedLabel,
	LabelStreamWinner,
	ListedAssessment,
	Subject,
} from "./assessment-store.js";
import type { StoredDeadLetter } from "./dead-letters.js";
import type { FindingSeverity } from "./evidence.js";
import type { FindingSource } from "./findings.js";
import type { StoredOperatorAction } from "./operator-actions.js";
import { derivePublicState } from "./public-assessment.js";

export interface AssessmentRun {
	id: string;
	runKey: string;
	uri: string;
	cid: string;
	artifactId: string | null;
	artifactChecksum: string | null;
	state: AssessmentState;
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
	createdAt: string;
}

export interface IssuedLabel {
	val: string;
	cts: string;
	exp: string | null;
	neg: boolean;
	sequence: number;
}

/** The active label state for a subject `(src, uri)` at a CID — the current
 * stream winner per value, including manual/override labels that carry no
 * `assessment_id` and so never appear in the assessment-scoped label list. */
export interface SubjectLabel {
	val: string;
	cid: string | null;
	active: boolean;
	neg: boolean;
	automated: boolean;
	cts: string;
	exp: string | null;
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

/** An active, reviewer/admin-issued label on the subject, surfaced as neutral
 * publisher-history context. `cid` is present only for a CID-bound label. */
export interface PublisherHistoryLabel {
	val: string;
	cid?: string;
}

/**
 * Neutral publisher-history context assembled at console read-time from the
 * labeler's own D1 (plan W8.4 D5): the publishing DID's prior releases and the
 * subject's active manual labels. `priorReleaseCount` is bounded by the
 * read-time cap — `priorReleaseCapped` true means "at least this many". Never
 * part of any public serializer; served only on the reviewer-gated console API.
 */
export interface PublisherHistory {
	did: string;
	priorReleaseCount: number;
	priorReleaseCapped: boolean;
	priorReleaseSample: string[];
	activeManualLabels: PublisherHistoryLabel[];
}

export interface SubjectHistoryView {
	subject: SubjectRecord;
	assessments: AssessmentRun[];
	publisherHistory: PublisherHistory;
}

export interface OperatorActionView {
	id: string;
	actorType: "human" | "service";
	actorId: string;
	actorEmail: string | null;
	actorCommonName: string | null;
	role: OperatorRole;
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
	deadLetterDepth: number;
}

/** A `dead_letters` row for the operator console. The raw `payload` (unverified
 * Jetstream bytes) is deliberately excluded — the console displays the failure
 * reason and resolution state, never the untrusted record. */
export interface DeadLetter {
	id: number;
	did: string;
	collection: string;
	rkey: string;
	reason: string;
	detail: string | null;
	status: string;
	receivedAt: string;
	resolvedAt: string | null;
	resolvedByActionId: string | null;
}

export interface Page<T> {
	items: T[];
	nextCursor?: string;
}

export function serializeAssessmentRun(row: ListedAssessment): AssessmentRun {
	return {
		id: row.id,
		runKey: row.runKey,
		uri: row.uri,
		cid: row.cid,
		artifactId: row.artifactId,
		artifactChecksum: row.artifactChecksum,
		state: row.state,
		publicState: derivePublicState(row.state, row.isSuperseded),
		trigger: row.trigger,
		triggerId: row.triggerId,
		policyVersion: row.policyVersion,
		modelId: row.modelId,
		promptHash: row.promptHash,
		publicSummary: row.publicSummary,
		supersedesAssessmentId: row.supersedesAssessmentId,
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		createdAt: row.createdAt,
		isSuperseded: row.isSuperseded,
	};
}

export function serializeOperatorFinding(finding: AssessmentFinding): OperatorFinding {
	return {
		id: finding.id,
		assessmentId: finding.assessmentId,
		source: finding.source,
		category: finding.category,
		severity: finding.severity,
		...(finding.confidence !== null ? { confidence: finding.confidence } : {}),
		title: finding.title,
		publicSummary: finding.publicSummary,
		privateDetail: finding.privateDetail,
		evidenceRefs: finding.evidenceRefs,
		createdAt: finding.createdAt,
	};
}

export function serializeIssuedLabel(label: AssessmentIssuedLabel): IssuedLabel {
	return {
		val: label.val,
		cts: label.cts,
		exp: label.exp,
		neg: label.neg,
		sequence: label.sequence,
	};
}

export function serializeSubjectLabel(winner: LabelStreamWinner): SubjectLabel {
	return {
		val: winner.val,
		cid: winner.cid,
		active: winner.active,
		neg: winner.neg,
		automated: winner.automated,
		cts: winner.cts,
		exp: winner.exp,
		sequence: winner.sequence,
	};
}

/**
 * Assembles the publisher-history block from the slice-1 queries
 * (`getPriorReleaseUrisForDid`, `getActiveLabelState`). The prior-release count
 * is the number of URIs returned under the cap; `capped` matches the pipeline
 * stage's rule (`length >= limit`). Active manual labels are the non-automated,
 * currently-active stream winners — the same `!automated && active` filter the
 * history stage applies.
 */
export function serializePublisherHistory(input: {
	did: string;
	priorReleaseUris: readonly string[];
	priorReleaseLimit: number;
	priorReleaseSampleSize: number;
	labelWinners: Iterable<LabelStreamWinner>;
}): PublisherHistory {
	const activeManualLabels: PublisherHistoryLabel[] = [];
	for (const winner of input.labelWinners) {
		if (winner.automated || !winner.active) continue;
		activeManualLabels.push(
			winner.cid === null ? { val: winner.val } : { val: winner.val, cid: winner.cid },
		);
	}
	return {
		did: input.did,
		priorReleaseCount: input.priorReleaseUris.length,
		priorReleaseCapped: input.priorReleaseUris.length >= input.priorReleaseLimit,
		priorReleaseSample: input.priorReleaseUris.slice(0, input.priorReleaseSampleSize),
		activeManualLabels,
	};
}

export function serializeSubjectRecord(subject: Subject): SubjectRecord {
	return {
		uri: subject.uri,
		cid: subject.cid,
		did: subject.did,
		collection: subject.collection,
		rkey: subject.rkey,
		observedAt: subject.observedAt,
		deletedAt: subject.deletedAt,
	};
}

/** Drops the internal replay fields (`idempotencyKey`, `requestFingerprint`,
 * `resultJson`) and the epoch-ms sibling; keeps the "who did what, under which
 * role, why" record the console displays. */
export function serializeOperatorActionView(action: StoredOperatorAction): OperatorActionView {
	return {
		id: action.id,
		actorType: action.actorType,
		actorId: action.actorId,
		actorEmail: action.actorEmail,
		actorCommonName: action.actorCommonName,
		role: action.role,
		action: action.action,
		subjectUri: action.subjectUri,
		subjectCid: action.subjectCid,
		labelValue: action.labelValue,
		reason: action.reason,
		createdAt: action.createdAt,
	};
}

export function serializeDeadLetter(row: StoredDeadLetter): DeadLetter {
	return {
		id: row.id,
		did: row.did,
		collection: row.collection,
		rkey: row.rkey,
		reason: row.reason,
		detail: row.detail,
		status: row.status,
		receivedAt: row.receivedAt,
		resolvedAt: row.resolvedAt,
		resolvedByActionId: row.resolvedByActionId,
	};
}
