import {
	FIXTURE_ASSESSMENTS,
	FIXTURE_FINDINGS_BY_ASSESSMENT,
	FIXTURE_LABELS_BY_ASSESSMENT,
	FIXTURE_OPERATOR_ACTIONS,
	FIXTURE_SUBJECT_HISTORY,
	FIXTURE_SYSTEM_STATUS,
} from "../fixtures/index.js";
import type {
	AssessmentRun,
	IssuedLabel,
	ListAssessmentsParams,
	ListAuditLogParams,
	OperatorAction,
	OperatorFinding,
	Page,
	SubjectHistoryView,
	SystemStatusSnapshot,
} from "./types.js";

export const CONSOLE_API_BASE = "/admin/api";

/** The console's data-access contract. `fixtureClient` below is the only
 * implementation wired up today; `createFetchClient` talks to the real
 * Worker routes once W9.4-W9.6 land — swapping `apiClient`'s assignment at
 * the bottom of this file is the only change either side needs. */
export interface LabelerConsoleClient {
	listAssessments(params?: ListAssessmentsParams): Promise<Page<AssessmentRun>>;
	getAssessment(id: string): Promise<AssessmentRun | null>;
	listFindings(assessmentId: string): Promise<OperatorFinding[]>;
	listLabels(assessmentId: string): Promise<IssuedLabel[]>;
	getSubjectHistory(uri: string): Promise<SubjectHistoryView | null>;
	listAuditLog(params?: ListAuditLogParams): Promise<Page<OperatorAction>>;
	getSystemStatus(): Promise<SystemStatusSnapshot>;
}

interface ApiErrorBody {
	error?: { code?: string; message?: string };
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
	return typeof value === "object" && value !== null;
}

/** Fetch wrapper for the future `/admin/api/*` surface — required headers
 * per the labeler's mutation-guard CSRF contract (plan W9.2), carried here
 * even though every route this client calls today is a read. */
function consoleApiFetch(path: string, init?: RequestInit): Promise<Response> {
	const headers = new Headers(init?.headers);
	headers.set("X-EmDash-Request", "1");
	return fetch(`${CONSOLE_API_BASE}${path}`, { ...init, headers, credentials: "same-origin" });
}

async function parseJson<T>(response: Response, fallback: string): Promise<T> {
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => undefined);
		const message =
			isApiErrorBody(body) && typeof body.error?.message === "string"
				? body.error.message
				: fallback;
		throw new Error(message);
	}
	const body: { data: T } = await response.json();
	return body.data;
}

/** Talks to the real `/admin/api/*` routes. Not wired up yet — see
 * `apiClient` at the bottom of this file. */
export function createFetchClient(): LabelerConsoleClient {
	return {
		async listAssessments(params = {}) {
			const search = new URLSearchParams();
			if (params.state) search.set("state", params.state);
			if (params.cursor) search.set("cursor", params.cursor);
			if (params.limit) search.set("limit", String(params.limit));
			const response = await consoleApiFetch(`/assessments?${search.toString()}`);
			return parseJson(response, "Failed to load assessments");
		},
		async getAssessment(id) {
			const response = await consoleApiFetch(`/assessments/${encodeURIComponent(id)}`);
			if (response.status === 404) return null;
			return parseJson(response, "Failed to load assessment");
		},
		async listFindings(assessmentId) {
			const response = await consoleApiFetch(
				`/assessments/${encodeURIComponent(assessmentId)}/findings`,
			);
			return parseJson(response, "Failed to load findings");
		},
		async listLabels(assessmentId) {
			const response = await consoleApiFetch(
				`/assessments/${encodeURIComponent(assessmentId)}/labels`,
			);
			return parseJson(response, "Failed to load labels");
		},
		async getSubjectHistory(uri) {
			const response = await consoleApiFetch(`/subjects/${encodeURIComponent(uri)}`);
			if (response.status === 404) return null;
			return parseJson(response, "Failed to load subject history");
		},
		async listAuditLog(params = {}) {
			const search = new URLSearchParams();
			if (params.cursor) search.set("cursor", params.cursor);
			if (params.limit) search.set("limit", String(params.limit));
			const response = await consoleApiFetch(`/audit-log?${search.toString()}`);
			return parseJson(response, "Failed to load audit log");
		},
		async getSystemStatus() {
			const response = await consoleApiFetch("/status");
			return parseJson(response, "Failed to load system status");
		},
	};
}

/** Reads the static fixtures under src/fixtures/ — the only client wired
 * up until the labeler's `/admin/api/*` routes exist. */
function createFixtureClient(): LabelerConsoleClient {
	return {
		async listAssessments(params = {}) {
			const filtered = params.state
				? FIXTURE_ASSESSMENTS.filter((a) => a.publicState === params.state)
				: FIXTURE_ASSESSMENTS;
			const limit = params.limit ?? 50;
			return { items: filtered.slice(0, limit) };
		},
		async getAssessment(id) {
			return FIXTURE_ASSESSMENTS.find((a) => a.id === id) ?? null;
		},
		async listFindings(assessmentId) {
			return [...(FIXTURE_FINDINGS_BY_ASSESSMENT[assessmentId] ?? [])];
		},
		async listLabels(assessmentId) {
			return [...(FIXTURE_LABELS_BY_ASSESSMENT[assessmentId] ?? [])];
		},
		async getSubjectHistory(uri) {
			return FIXTURE_SUBJECT_HISTORY[uri] ?? null;
		},
		async listAuditLog() {
			return { items: [...FIXTURE_OPERATOR_ACTIONS] };
		},
		async getSystemStatus() {
			return FIXTURE_SYSTEM_STATUS;
		},
	};
}

export const apiClient: LabelerConsoleClient = createFixtureClient();
