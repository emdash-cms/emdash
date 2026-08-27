export type OperatorRole = "admin" | "reviewer";

export interface OperatorSession {
	authenticated: true;
	identity: {
		kind: "human" | "service";
		principal: string;
		actorDid: string;
		roles: OperatorRole[];
	};
}

export interface HealthStatus {
	service: string;
	status: "ok" | "not-ready";
	discovery: Record<string, unknown> & { ready?: boolean };
	signing: { ready: boolean; reason?: string };
}

export type AssessmentState =
	| "pending"
	| "running"
	| "review"
	| "error"
	| "passed"
	| "blocked"
	| "superseded"
	| "cancelled";

export interface AssessmentListItem {
	run_key: string;
	subject_uri: string;
	subject_cid: string;
	subject_kind: "profile" | "release";
	state: AssessmentState;
	assessment_state: AssessmentState;
	state_version: number;
	policy_version: string;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
}

export interface AssessmentDetail {
	assessment: AssessmentListItem & {
		moderation_fingerprint?: string | null;
		coverage?: unknown;
		canonicalInput?: unknown;
		summary?: unknown;
		error_code?: string | null;
	};
	findings?: Array<{
		finding_index: number;
		category: string;
		confidence: number | null;
		reason_code: string;
		public_summary: string;
		evidenceRefs: unknown;
		created_at: string;
	}>;
	manualDecision: null | {
		action: "approve" | "block";
		actorDid: string;
		actorRole: OperatorRole;
		reason: string;
		createdAt: string;
	};
}

export interface IssuanceStatus {
	paused: boolean;
	updatedAt: string | null;
}

export interface EvaluationListItem {
	id: number;
	actor_did: string;
	reason: string;
	status: "running" | "succeeded" | "failed";
	budget_passed: 0 | 1 | null;
	baseline_run_id: number | null;
	failure_code: string | null;
	failure_summary: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
}

export interface ActivityItem {
	id: number;
	actor_did: string;
	actor_role: OperatorRole;
	action: string;
	subject_uri: string | null;
	subject_cid: string | null;
	reason: string;
	idempotency_key: string;
	created_at: string;
}

export interface Page<T> {
	items: T[];
	nextCursor?: string;
}

export class OperatorApiError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = "OperatorApiError";
		this.code = code;
		this.status = status;
	}
}

export function getSession(): Promise<OperatorSession> {
	return requestJson("/_admin/api/session");
}

export function getHealth(): Promise<HealthStatus> {
	return requestJson("/health");
}

export function getAssessments(
	state: AssessmentState,
	cursor?: string,
): Promise<Page<AssessmentListItem>> {
	const query = new URLSearchParams({ state, limit: "50" });
	if (cursor) query.set("cursor", cursor);
	return requestJson(`/_admin/api/assessments?${query}`);
}

export function getAssessment(runKey: string): Promise<AssessmentDetail> {
	return requestJson(`/_admin/api/assessments/${encodeURIComponent(runKey)}`);
}

export function getIssuance(): Promise<IssuanceStatus> {
	return requestJson("/_admin/api/issuance");
}

export function getEvaluations(cursor?: string): Promise<Page<EvaluationListItem>> {
	return requestPage("/_admin/api/evals", cursor);
}

export function getActivity(cursor?: string): Promise<Page<ActivityItem>> {
	return requestPage("/_admin/api/activity", cursor);
}

export function getEvaluation(runId: number): Promise<Record<string, unknown>> {
	return requestJson(`/_admin/api/evals/${runId}`);
}

export function assessmentAction(
	run: AssessmentListItem,
	action: "approve" | "block" | "rerun",
	reason: string,
): Promise<unknown> {
	return mutate(`/_admin/api/assessments/${encodeURIComponent(run.run_key)}/${action}`, {
		reason,
		uri: run.subject_uri,
		cid: run.subject_cid,
	});
}

export function setIssuance(paused: boolean, reason: string): Promise<{ paused: boolean }> {
	return mutate(`/_admin/api/issuance/${paused ? "pause" : "resume"}`, { reason });
}

export function setTakedown(uri: string, retract: boolean, reason: string): Promise<unknown> {
	return mutate(`/_admin/api/takedown${retract ? "/retract" : ""}`, { uri, reason });
}

export function startEvaluation(reason: string): Promise<Record<string, unknown>> {
	return mutate("/_admin/api/evals/run", { reason });
}

async function requestPage<T>(path: string, cursor?: string): Promise<Page<T>> {
	const query = new URLSearchParams({ limit: "50" });
	if (cursor) query.set("cursor", cursor);
	return requestJson(`${path}?${query}`);
}

async function mutate<T>(path: string, body: Record<string, unknown>): Promise<T> {
	return requestJson(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-EmDash-Request": "1",
			"Idempotency-Key": crypto.randomUUID(),
		},
		body: JSON.stringify(body),
	});
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, init);
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new OperatorApiError(
			"INVALID_RESPONSE",
			i18n._(INVALID_RESPONSE_MESSAGE),
			response.status,
		);
	}
	if (!response.ok) {
		const error = readError(value);
		throw new OperatorApiError(error.code, error.message, response.status);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same-deployment endpoint contracts are covered by Worker and client tests.
	return value as T;
}

function readError(value: unknown): { code: string; message: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { code: "REQUEST_FAILED", message: i18n._(REQUEST_FAILED_MESSAGE) };
	}
	const error = Reflect.get(value, "error");
	if (typeof error !== "object" || error === null || Array.isArray(error)) {
		return { code: "REQUEST_FAILED", message: i18n._(REQUEST_FAILED_MESSAGE) };
	}
	const code = Reflect.get(error, "code");
	const message = Reflect.get(error, "message");
	return {
		code: typeof code === "string" ? code : "REQUEST_FAILED",
		message: typeof message === "string" ? message : i18n._(REQUEST_FAILED_MESSAGE),
	};
}
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

const INVALID_RESPONSE_MESSAGE = msg`The service returned an invalid response`;
const REQUEST_FAILED_MESSAGE = msg`The request failed`;
