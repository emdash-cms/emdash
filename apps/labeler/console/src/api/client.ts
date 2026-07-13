import {
	FIXTURE_ASSESSMENTS,
	FIXTURE_FINDINGS_BY_ASSESSMENT,
	FIXTURE_LABELS_BY_ASSESSMENT,
	FIXTURE_OPERATOR_ACTIONS,
	FIXTURE_SUBJECT_HISTORY,
	FIXTURE_SYSTEM_STATUS,
} from "../fixtures/index.js";
import type {
	AssessmentActionInput,
	AssessmentRun,
	EffectPreview,
	EffectPreviewParams,
	EmergencyActionInput,
	EmergencyActionKind,
	IssuedLabel,
	IssuedLabelDescriptor,
	LabelActionInput,
	ListAssessmentsParams,
	ListAuditLogParams,
	OperatorAction,
	OverrideActionInput,
	OverrideEffectPreviewParams,
	OverrideResult,
	OverrideRetractResult,
	OperatorFinding,
	Page,
	RerunResult,
	SubjectHistoryView,
	SubjectLabel,
	SystemStatusSnapshot,
	WhoamiIdentity,
} from "./types.js";

export const CONSOLE_API_BASE = "/admin/api";

/** The console's data-access contract. `createFetchClient` talks to the real
 * Access-guarded `/admin/api/*` Worker routes and is what `apiClient` uses;
 * `createFixtureClient` reads the static sample data and is kept exported for
 * tests and offline UI work. */
export interface LabelerConsoleClient {
	listAssessments(params?: ListAssessmentsParams): Promise<Page<AssessmentRun>>;
	getAssessment(id: string): Promise<AssessmentRun | null>;
	listFindings(assessmentId: string): Promise<OperatorFinding[]>;
	listLabels(assessmentId: string): Promise<IssuedLabel[]>;
	getSubjectHistory(uri: string): Promise<SubjectHistoryView | null>;
	getSubjectLabels(uri: string, cid?: string): Promise<SubjectLabel[]>;
	listAuditLog(params?: ListAuditLogParams): Promise<Page<OperatorAction>>;
	getSystemStatus(): Promise<SystemStatusSnapshot>;
	whoami(): Promise<WhoamiIdentity>;
	previewEffect(params: EffectPreviewParams): Promise<EffectPreview>;
	previewOverrideEffect(params: OverrideEffectPreviewParams): Promise<EffectPreview>;
	issueLabel(input: LabelActionInput): Promise<IssuedLabelDescriptor>;
	retractLabel(input: LabelActionInput): Promise<IssuedLabelDescriptor>;
	rerunAssessment(id: string, input: AssessmentActionInput): Promise<RerunResult>;
	overrideAssessment(id: string, input: OverrideActionInput): Promise<OverrideResult>;
	retractOverride(id: string, input: AssessmentActionInput): Promise<OverrideRetractResult>;
	emergencyAction(
		kind: EmergencyActionKind,
		mode: "issue" | "retract",
		input: EmergencyActionInput,
	): Promise<IssuedLabelDescriptor>;
}

/** The admin-only emergency endpoints, keyed by action and direction. */
const EMERGENCY_PATHS: Record<EmergencyActionKind, { issue: string; retract: string }> = {
	takedown: { issue: "/emergency/takedown", retract: "/emergency/takedown-retract" },
	"publisher-compromised": {
		issue: "/emergency/publisher-compromised",
		retract: "/emergency/publisher-compromised-retract",
	},
};

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

/** POST a state-changing label action. `consoleApiFetch` already sets the CSRF
 * header and same-origin credentials; this adds the JSON content type the
 * mutation guard requires and threads the client-minted idempotency key. */
async function postAction<T>(path: string, input: unknown, fallback: string): Promise<T> {
	const response = await consoleApiFetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseJson(response, fallback);
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

/** Talks to the real Access-guarded `/admin/api/*` routes — the client
 * `apiClient` uses. */
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
		async getSubjectLabels(uri, cid) {
			const search = new URLSearchParams();
			if (cid) search.set("cid", cid);
			const query = search.toString();
			const response = await consoleApiFetch(
				`/subjects/${encodeURIComponent(uri)}/labels${query ? `?${query}` : ""}`,
			);
			return parseJson(response, "Failed to load subject labels");
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
		async whoami() {
			const response = await consoleApiFetch("/whoami");
			return parseJson(response, "Failed to load identity");
		},
		async previewEffect(params) {
			const search = new URLSearchParams();
			search.set("uri", params.uri);
			search.set("val", params.val);
			if (params.cid) search.set("cid", params.cid);
			if (params.neg) search.set("neg", "true");
			const response = await consoleApiFetch(`/labels/effect-preview?${search.toString()}`);
			return parseJson(response, "Failed to preview effect");
		},
		async previewOverrideEffect(params) {
			const search = new URLSearchParams();
			search.set("uri", params.uri);
			search.set("cid", params.cid);
			for (const val of params.negate) search.append("negate", val);
			const response = await consoleApiFetch(
				`/labels/override-effect-preview?${search.toString()}`,
			);
			return parseJson(response, "Failed to preview override effect");
		},
		async issueLabel(input) {
			return postAction("/labels/issue", input, "Failed to submit label action");
		},
		async retractLabel(input) {
			return postAction("/labels/retract", input, "Failed to submit label action");
		},
		async rerunAssessment(id, input) {
			return postAction(
				`/assessments/${encodeURIComponent(id)}/rerun`,
				input,
				"Failed to rerun assessment",
			);
		},
		async overrideAssessment(id, input) {
			return postAction(
				`/assessments/${encodeURIComponent(id)}/override`,
				input,
				"Failed to override assessment",
			);
		},
		async retractOverride(id, input) {
			return postAction(
				`/assessments/${encodeURIComponent(id)}/override-retract`,
				input,
				"Failed to retract override",
			);
		},
		async emergencyAction(kind, mode, input) {
			return postAction(EMERGENCY_PATHS[kind][mode], input, "Failed to submit emergency action");
		},
	};
}

/** Reads the static fixtures under src/fixtures/ — used by tests and offline
 * UI work. */
export function createFixtureClient(): LabelerConsoleClient {
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
		async getSubjectLabels() {
			return [];
		},
		async listAuditLog() {
			return { items: [...FIXTURE_OPERATOR_ACTIONS] };
		},
		async getSystemStatus() {
			return FIXTURE_SYSTEM_STATUS;
		},
		async whoami() {
			return {
				kind: "human",
				principal: "reviewer@example.com",
				sub: "dev-reviewer",
				roles: ["reviewer"],
			};
		},
		async previewEffect(params) {
			return {
				labelEffect: params.val === "security-yanked" ? "block" : "warn",
				scope: params.cid ? "cid-bound" : "uri-wide",
				supersedes: [],
				before: null,
				after: null,
			};
		},
		async previewOverrideEffect() {
			return { labelEffect: "pass", scope: "cid-bound", supersedes: [], before: null, after: null };
		},
		async issueLabel(input) {
			return {
				actionId: "oact_fixture",
				val: input.val,
				uri: input.uri,
				cid: input.cid ?? null,
				neg: false,
				cts: new Date().toISOString(),
				effect: input.val === "security-yanked" ? "block" : "warn",
			};
		},
		async retractLabel(input) {
			return {
				actionId: "oact_fixture",
				val: input.val,
				uri: input.uri,
				cid: input.cid ?? null,
				neg: true,
				cts: new Date().toISOString(),
				effect: input.val === "security-yanked" ? "block" : "warn",
			};
		},
		async rerunAssessment() {
			return {
				actionId: "oact_fixture",
				runId: "asmt_fixture",
				triggerId: "operator:oact_fixture",
				uri: "at://did:plc:x/com.emdashcms.experimental.package.release/rk1",
				cid: "bafyfixture",
				cts: new Date().toISOString(),
			};
		},
		async overrideAssessment(_id, input) {
			return {
				actionId: "oact_fixture",
				uri: "at://did:plc:x/com.emdashcms.experimental.package.release/rk1",
				cid: "bafyfixture",
				negated: input.negate,
				issued: ["assessment-passed", "assessment-overridden"],
				cts: new Date().toISOString(),
			};
		},
		async retractOverride() {
			return {
				actionId: "oact_fixture",
				uri: "at://did:plc:x/com.emdashcms.experimental.package.release/rk1",
				cid: "bafyfixture",
				negated: ["assessment-passed", "assessment-overridden"],
				cts: new Date().toISOString(),
			};
		},
		async emergencyAction(kind, mode, input) {
			return {
				actionId: "oact_fixture",
				val: kind === "takedown" ? "!takedown" : "publisher-compromised",
				uri: input.uri,
				cid: null,
				neg: mode === "retract",
				cts: new Date().toISOString(),
				effect: kind === "takedown" ? "redact" : "block",
			};
		},
	};
}

export const apiClient: LabelerConsoleClient = createFetchClient();
