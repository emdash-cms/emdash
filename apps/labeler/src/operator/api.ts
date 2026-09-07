import {
	EvalRunFailedError,
	EvalRunInProgressError,
	createD1EvalRunStore,
	readEvalRunStatus,
	startProductionLiveEvaluation,
	type EvalRunInput,
	type EvalRunStatusResponse,
} from "../../evals/production.js";
import {
	authenticateOperator,
	hasOperatorRole,
	operatorActorDid,
	type OperatorIdentity,
	type OperatorRole,
} from "../access.js";
import { createAggregatorReconciliationClient } from "../aggregator-reconciliation.js";
import { createD1AssessmentLifecycleStore } from "../assessment/lifecycle.js";
import { createAssessmentWorkflowParams } from "../assessment/run-key.js";
import { createProductionListingLabelIssuer } from "../assessment/runtime.js";
import type { AssessmentRunSnapshot } from "../assessment/types.js";
import { setIssuancePaused } from "../issuance-control.js";
import type { ListingLabelIssuer } from "../labels/issuer.js";
import {
	createReconciliationWorkflowControl,
	ensureAssessmentWorkflowRuns,
	type AssessmentWorkflowControlBinding,
} from "../reconciliation/workflows.js";
import { readAssessmentVersions } from "../runtime-config.js";

const ASSESSMENT_ACTION_RE =
	/^\/_admin\/api\/assessments\/([A-Za-z0-9._:-]{1,200})\/(approve|block|rerun)$/;
const ASSESSMENT_DETAIL_RE = /^\/_admin\/api\/assessments\/([A-Za-z0-9._:-]{1,200})$/;
const EVAL_DETAIL_RE = /^\/_admin\/api\/evals\/([1-9][0-9]*)$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const BASE64_PADDING_RE = /=+$/;
const MAX_BODY_BYTES = 16 * 1024;
const OPERATOR_ASSESSMENT_STATES = new Set([
	"pending",
	"running",
	"review",
	"error",
	"passed",
	"blocked",
	"superseded",
	"cancelled",
]);
const EFFECTIVE_OPERATOR_STATE_SQL = `CASE
	WHEN assessment.state IN ('superseded', 'cancelled') THEN assessment.state
	WHEN decision.action = 'approve' THEN 'passed'
	WHEN decision.action = 'block' THEN 'blocked'
	ELSE assessment.state
END`;

export interface OperatorManualDecisionSummary {
	id?: number;
	action: "approve" | "block";
	actorDid: string;
	actorRole: "reviewer" | "admin";
	reason: string;
	idempotencyKey?: string;
	createdAt: string;
}

export interface OperatorAssessmentReader {
	all(
		sql: string,
		bindings: readonly (string | number)[],
	): Promise<readonly Record<string, unknown>[]>;
}

export interface OperatorAssessmentPage {
	items: readonly Record<string, unknown>[];
	nextCursor?: string;
}

export interface OperatorIssuanceStatus {
	paused: boolean;
	updatedAt: string | null;
}

export interface OperatorEvaluationPage {
	items: readonly Record<string, unknown>[];
	nextCursor?: string;
}

export interface OperatorActivityPage {
	items: readonly Record<string, unknown>[];
	nextCursor?: string;
}

export class InvalidOperatorCursorError extends Error {
	override readonly name = "InvalidOperatorCursorError";
}

export interface OperatorActionRecord {
	actorDid: string;
	actorRole: "reviewer" | "admin";
	action: "rerun";
	subjectUri: string;
	subjectCid: string;
	reason: string;
	idempotencyKey: string;
	createdAt: string;
}

export interface OperatorRerunActionStore {
	insertIfAbsent(input: OperatorActionRecord): Promise<void>;
	read(idempotencyKey: string): Promise<OperatorActionRecord | undefined>;
}

export interface OperatorApiDependencies {
	authenticate(request: Request): Promise<OperatorIdentity>;
	actorDid(identity: OperatorIdentity): Promise<string>;
	getRun(runKey: string): Promise<AssessmentRunSnapshot | null>;
	isCurrentSubject(uri: string, cid: string): Promise<boolean>;
	getManualDecision?(
		subject: AssessmentRunSnapshot["subject"],
	): Promise<OperatorManualDecisionSummary | null>;
	issuer: Pick<ListingLabelIssuer, "approve" | "block" | "issue">;
	rerun(input: {
		run: AssessmentRunSnapshot;
		actorDid: string;
		role: "reviewer" | "admin";
		reason: string;
		idempotencyKey: string;
		now: Date;
	}): Promise<string>;
	runEvaluation?(input: EvalRunInput): Promise<EvalRunStatusResponse>;
	readEvaluation?(runId: number): Promise<EvalRunStatusResponse | null>;
	readIssuance?(): Promise<OperatorIssuanceStatus>;
	listEvaluations?(limit: number, cursor?: string): Promise<OperatorEvaluationPage>;
	listActivity?(limit: number, cursor?: string): Promise<OperatorActivityPage>;
	now(): Date;
}

export async function handleOperatorApi(
	request: Request,
	env: Env,
	dependencies?: OperatorApiDependencies,
): Promise<Response> {
	if (request.method === "GET") return handleOperatorRead(request, env, dependencies);
	if (request.method !== "POST") return apiError("METHOD_NOT_ALLOWED", "POST required", 405);
	const transportError = validateMutationTransport(request);
	if (transportError) return transportError;

	let identity: OperatorIdentity;
	try {
		identity = await (dependencies?.authenticate(request) ?? authenticateOperator(request, env));
	} catch {
		return apiError("UNAUTHENTICATED", "Operator authentication required", 401);
	}
	const url = new URL(request.url);
	const assessmentAction = ASSESSMENT_ACTION_RE.exec(url.pathname);
	const takedownAction =
		url.pathname === "/_admin/api/takedown"
			? "takedown"
			: url.pathname === "/_admin/api/takedown/retract"
				? "retract-takedown"
				: null;
	const issuanceAction =
		url.pathname === "/_admin/api/issuance/pause"
			? "pause"
			: url.pathname === "/_admin/api/issuance/resume"
				? "resume"
				: null;
	const evalAction = url.pathname === "/_admin/api/evals/run";
	const requiredRole: OperatorRole =
		takedownAction || issuanceAction || evalAction ? "admin" : "reviewer";
	if (!assessmentAction && !takedownAction && !issuanceAction && !evalAction) {
		return apiError("NOT_FOUND", "Operator action was not found", 404);
	}
	if (!hasOperatorRole(identity, requiredRole)) {
		return apiError("FORBIDDEN", "Operator role is not authorized for this action", 403);
	}

	const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
	if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
		return apiError("INVALID_REQUEST", "A valid idempotency key is required", 400);
	}
	const body = await parseMutationBody(request);
	if (!body) return apiError("INVALID_REQUEST", "Request body is invalid", 400);
	const reason = body["reason"];
	if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1_000) {
		return apiError("INVALID_REQUEST", "A non-empty reason is required", 400);
	}
	const now = dependencies?.now() ?? new Date();
	const actorDid = await (dependencies?.actorDid(identity) ?? operatorActorDid(identity));
	const role: "reviewer" | "admin" = identity.roles.includes("admin") ? "admin" : "reviewer";

	try {
		if (evalAction) {
			if (dependencies && !dependencies.runEvaluation) {
				return apiError("NOT_IMPLEMENTED", "Injected evaluation runner is unavailable", 501);
			}
			const evalInput: EvalRunInput = {
				actorDid,
				role: "admin",
				reason,
				idempotencyKey,
				now,
			};
			const evaluation = await (dependencies?.runEvaluation?.(evalInput) ??
				startProductionLiveEvaluation(env, evalInput));
			return mutationResponse(evaluation, evaluation.status === "running" ? 202 : 200);
		}
		if (issuanceAction) {
			if (dependencies) {
				return apiError("NOT_IMPLEMENTED", "Injected issuance control is unavailable", 501);
			}
			return mutationResponse(
				await setIssuancePaused({
					db: env.DB,
					paused: issuanceAction === "pause",
					actorDid,
					role: "admin",
					reason,
					idempotencyKey,
					now,
				}),
			);
		}
		const issuer = dependencies?.issuer ?? (await createProductionListingLabelIssuer(env));
		if (assessmentAction) {
			const [, runKey, action] = assessmentAction;
			const run = await (dependencies?.getRun(runKey!) ??
				createD1AssessmentLifecycleStore(env.DB).getRun(runKey!));
			if (!run) return apiError("NOT_FOUND", "Assessment was not found", 404);
			if (run.deleted) return apiError("SUBJECT_DELETED", "Assessment subject was deleted", 409);
			if (body["uri"] !== run.subject.uri || body["cid"] !== run.subject.cid) {
				return apiError("SUBJECT_CHANGED", "Assessment URI or CID no longer matches", 409);
			}
			const authoritativeCurrent = dependencies
				? await dependencies.isCurrentSubject(run.subject.uri, run.subject.cid)
				: await createAggregatorReconciliationClient(
						env.AGGREGATOR_RECONCILIATION,
						env.RECONCILIATION_TOKEN,
					).isCurrentSubject(run.subject.uri, run.subject.cid);
			if (!authoritativeCurrent) {
				return apiError("SUBJECT_CHANGED", "Assessment subject is no longer current", 409);
			}
			if (
				action === "approve" &&
				run.state !== "review" &&
				run.state !== "error" &&
				run.state !== "blocked"
			) {
				return apiError("INVALID_STATE", "Assessment is not awaiting an operator decision", 409);
			}
			if (
				action === "block" &&
				run.state !== "review" &&
				run.state !== "error" &&
				run.state !== "passed" &&
				run.state !== "blocked"
			) {
				return apiError("INVALID_STATE", "Assessment is not eligible for a block decision", 409);
			}
			if (action === "rerun" && (run.state === "cancelled" || run.state === "superseded")) {
				return apiError("INVALID_STATE", "Assessment cannot be rerun from its current state", 409);
			}
			const context = { actorDid, role, reason, idempotencyKey };
			if (action === "approve") {
				const decision = await issuer.approve(context, run.subject, now);
				return mutationResponse({
					action: decision.action,
					operatorActionId: decision.operatorActionId,
					sequences: decision.labels.map(({ sequence }) => sequence),
					subject: run.subject,
				});
			}
			if (action === "block") {
				const decision = await issuer.block(context, run.subject, now);
				return mutationResponse({
					action: decision.action,
					operatorActionId: decision.operatorActionId,
					sequences: decision.labels.map(({ sequence }) => sequence),
					subject: run.subject,
				});
			}
			const rerunKey = await (dependencies?.rerun({
				run,
				actorDid,
				role,
				reason,
				idempotencyKey,
				now,
			}) ?? productionRerun(env, run, actorDid, role, reason, idempotencyKey, now));
			return mutationResponse({ action: "rerun", runKey: rerunKey, subject: run.subject });
		}

		const uri = body["uri"];
		if (typeof uri !== "string" || (!uri.startsWith("at://") && !uri.startsWith("did:"))) {
			return apiError("INVALID_REQUEST", "Takedown subject URI is invalid", 400);
		}
		const issued = await issuer.issue(
			{
				actorDid,
				role: "admin",
				reason,
				idempotencyKey,
				operatorAction: { action: takedownAction!, idempotencyKey },
			},
			{
				subject: { uri },
				value: "!takedown",
				...(takedownAction === "retract-takedown" ? { negate: true } : {}),
			},
			now,
		);
		return mutationResponse({
			action: takedownAction,
			sequence: issued.sequence,
			subject: { uri },
		});
	} catch (error) {
		if (error instanceof EvalRunInProgressError) {
			return apiError(error.code, error.message, 409);
		}
		if (error instanceof EvalRunFailedError) {
			return apiError(error.code, error.message, 500);
		}
		if (error instanceof TypeError) return apiError("CONFLICT", "Operator action conflicted", 409);
		console.error(
			JSON.stringify({
				message: "operator mutation failed",
				path: url.pathname,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return apiError("OPERATOR_ACTION_FAILED", "Operator action could not be completed", 500);
	}
}

async function handleOperatorRead(
	request: Request,
	env: Env,
	dependencies?: OperatorApiDependencies,
): Promise<Response> {
	let identity: OperatorIdentity;
	try {
		identity = await (dependencies?.authenticate(request) ?? authenticateOperator(request, env));
	} catch {
		return apiError("UNAUTHENTICATED", "Operator authentication required", 401);
	}
	if (!hasOperatorRole(identity, "reviewer")) {
		return apiError("FORBIDDEN", "Operator role is not authorized for this action", 403);
	}
	const url = new URL(request.url);
	if (url.pathname === "/_admin/api/session") {
		return mutationResponse({
			authenticated: true,
			identity: {
				kind: identity.kind,
				principal: identity.kind === "human" ? identity.email : identity.commonName,
				actorDid: await (dependencies?.actorDid(identity) ?? operatorActorDid(identity)),
				roles: identity.roles,
			},
		});
	}
	if (url.pathname === "/_admin/api/issuance") {
		const status = dependencies?.readIssuance
			? await dependencies.readIssuance()
			: await readProductionIssuanceStatus(env.DB);
		return mutationResponse(status);
	}
	if (url.pathname === "/_admin/api/evals") {
		if (!hasOperatorRole(identity, "admin")) {
			return apiError("FORBIDDEN", "Operator role is not authorized for this resource", 403);
		}
		const limit = readPageLimit(url);
		try {
			const page = dependencies?.listEvaluations
				? await dependencies.listEvaluations(limit, url.searchParams.get("cursor") ?? undefined)
				: await readProductionEvaluationPage(
						env.DB,
						limit,
						url.searchParams.get("cursor") ?? undefined,
					);
			return mutationResponse(page);
		} catch (error) {
			if (error instanceof InvalidOperatorCursorError) {
				return apiError("INVALID_REQUEST", "Evaluation cursor is invalid", 400);
			}
			throw error;
		}
	}
	if (url.pathname === "/_admin/api/activity") {
		if (!hasOperatorRole(identity, "admin")) {
			return apiError("FORBIDDEN", "Operator role is not authorized for this resource", 403);
		}
		const limit = readPageLimit(url);
		try {
			const page = dependencies?.listActivity
				? await dependencies.listActivity(limit, url.searchParams.get("cursor") ?? undefined)
				: await readProductionActivityPage(
						env.DB,
						limit,
						url.searchParams.get("cursor") ?? undefined,
					);
			return mutationResponse(page);
		} catch (error) {
			if (error instanceof InvalidOperatorCursorError) {
				return apiError("INVALID_REQUEST", "Activity cursor is invalid", 400);
			}
			throw error;
		}
	}
	const evalDetail = EVAL_DETAIL_RE.exec(url.pathname);
	if (evalDetail) {
		if (!hasOperatorRole(identity, "admin")) {
			return apiError("FORBIDDEN", "Operator role is not authorized for this resource", 403);
		}
		const runId = Number(evalDetail[1]);
		if (!Number.isSafeInteger(runId)) {
			return apiError("INVALID_REQUEST", "Evaluation run ID is invalid", 400);
		}
		const evaluation = await (dependencies?.readEvaluation?.(runId) ??
			readEvalRunStatus(createD1EvalRunStore(env.DB), runId));
		return evaluation
			? mutationResponse(evaluation)
			: apiError("NOT_FOUND", "Evaluation run was not found", 404);
	}
	const detail = ASSESSMENT_DETAIL_RE.exec(url.pathname);
	if (detail) {
		const runKey = detail[1]!;
		if (dependencies) {
			const run = await dependencies.getRun(runKey);
			if (!run) return apiError("NOT_FOUND", "Assessment was not found", 404);
			const manualDecision = dependencies.getManualDecision
				? await dependencies.getManualDecision(run.subject)
				: null;
			return mutationResponse({ assessment: run, manualDecision });
		}
		const row = await env.DB.prepare(
			`SELECT run_key, subject_uri, subject_cid, subject_kind, state, state_version,
			        policy_version, moderation_fingerprint, coverage_json, canonical_input_json,
			        summary_json, error_code, created_at, updated_at, completed_at
			 FROM assessments WHERE run_key = ?`,
		)
			.bind(runKey)
			.first();
		if (!row) return apiError("NOT_FOUND", "Assessment was not found", 404);
		const findings = await env.DB.prepare(
			`SELECT finding_index, category, confidence, reason_code, public_summary,
			        evidence_refs_json, created_at
			 FROM findings WHERE assessment_id = ?
			 ORDER BY finding_index ASC, id ASC`,
		)
			.bind(runKey)
			.all();
		const manualDecision = await readProductionManualDecision(
			env.DB,
			row["subject_uri"],
			row["subject_cid"],
		);
		return mutationResponse({
			assessment: {
				...row,
				coverage: parseStoredJson(row["coverage_json"]),
				canonicalInput: parseStoredJson(row["canonical_input_json"]),
				summary: parseStoredJson(row["summary_json"]),
				coverage_json: undefined,
				canonical_input_json: undefined,
				summary_json: undefined,
			},
			findings: findings.results.map((finding) => ({
				...finding,
				evidenceRefs: parseStoredJson(finding["evidence_refs_json"]),
				evidence_refs_json: undefined,
			})),
			manualDecision,
		});
	}
	if (url.pathname !== "/_admin/api/assessments") {
		return apiError("NOT_FOUND", "Operator resource was not found", 404);
	}
	const state = url.searchParams.get("state") ?? "review";
	if (!OPERATOR_ASSESSMENT_STATES.has(state)) {
		return apiError("INVALID_REQUEST", "Assessment state filter is invalid", 400);
	}
	const limit = readPageLimit(url);
	try {
		const page = await readOperatorAssessmentPage(
			{
				async all(sql, bindings) {
					const rows = await env.DB.prepare(sql)
						.bind(...bindings)
						.all();
					return rows.results;
				},
			},
			{
				state,
				limit,
				cursor: url.searchParams.get("cursor") ?? undefined,
			},
		);
		return mutationResponse(page);
	} catch (error) {
		if (error instanceof InvalidOperatorCursorError) {
			return apiError("INVALID_REQUEST", "Assessment cursor is invalid", 400);
		}
		throw error;
	}
}

async function readProductionIssuanceStatus(db: D1Database): Promise<OperatorIssuanceStatus> {
	const row = await db
		.prepare("SELECT value, updated_at FROM service_state WHERE key = 'issuance_paused'")
		.first<{ value: string; updated_at: string }>();
	return { paused: row?.value === "1", updatedAt: row?.updated_at ?? null };
}

async function readProductionEvaluationPage(
	db: D1Database,
	limit: number,
	cursor?: string,
): Promise<OperatorEvaluationPage> {
	const before = decodeNumericCursor(cursor);
	const rows = await db
		.prepare(
			`SELECT id, actor_did, reason, status, budget_passed, baseline_run_id,
			        failure_code, failure_summary, created_at, updated_at, completed_at
			 FROM eval_runs
			 WHERE (? IS NULL OR id < ?)
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.bind(before, before, limit + 1)
		.all();
	return numericPage(rows.results, limit);
}

async function readProductionActivityPage(
	db: D1Database,
	limit: number,
	cursor?: string,
): Promise<OperatorActivityPage> {
	const before = decodeNumericCursor(cursor);
	const rows = await db
		.prepare(
			`SELECT id, actor_did, actor_role, action, subject_uri, subject_cid,
			        reason, idempotency_key, created_at
			 FROM operator_actions
			 WHERE (? IS NULL OR id < ?)
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.bind(before, before, limit + 1)
		.all();
	return numericPage(rows.results, limit);
}

function numericPage(
	rows: readonly Record<string, unknown>[],
	limit: number,
): { items: readonly Record<string, unknown>[]; nextCursor?: string } {
	const items = rows.slice(0, limit);
	const last = items.at(-1);
	return {
		items,
		...(rows.length > limit && last && typeof last["id"] === "number"
			? { nextCursor: String(last["id"]) }
			: {}),
	};
}

function decodeNumericCursor(value?: string): number | null {
	if (value === undefined) return null;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
		throw new InvalidOperatorCursorError("operator cursor is invalid");
	}
	return parsed;
}

function readPageLimit(url: URL): number {
	const requested = Number(url.searchParams.get("limit") ?? 50);
	return Number.isSafeInteger(requested) ? Math.min(100, Math.max(1, requested)) : 50;
}

async function productionRerun(
	env: Env,
	run: AssessmentRunSnapshot,
	actorDid: string,
	role: "reviewer" | "admin",
	reason: string,
	idempotencyKey: string,
	now: Date,
): Promise<string> {
	await claimRerunIdempotency(createD1OperatorRerunActionStore(env.DB), {
		actorDid,
		actorRole: role,
		action: "rerun",
		subjectUri: run.subject.uri,
		subjectCid: run.subject.cid,
		reason,
		idempotencyKey,
		createdAt: now.toISOString(),
	});
	const params = await createAssessmentWorkflowParams({
		subject: run.subject,
		versions: readAssessmentVersions(env),
		logicalTriggerId: `operator:${idempotencyKey}`,
	});
	await createD1AssessmentLifecycleStore(env.DB).observeRun({
		params,
		observedAt: now.toISOString(),
		makeCurrent: false,
	});
	await ensureOperatorRerunWorkflow(env.ASSESSMENT_WORKFLOW, params);
	return params.runKey;
}

export async function ensureOperatorRerunWorkflow(
	workflow: AssessmentWorkflowControlBinding,
	params: Awaited<ReturnType<typeof createAssessmentWorkflowParams>>,
): Promise<void> {
	const control = createReconciliationWorkflowControl(workflow);
	await ensureAssessmentWorkflowRuns({ workflow, ...control, runs: [params] });
}

export async function readOperatorAssessmentPage(
	reader: OperatorAssessmentReader,
	options: { state: string; limit: number; cursor?: string },
): Promise<OperatorAssessmentPage> {
	if (!OPERATOR_ASSESSMENT_STATES.has(options.state)) {
		throw new TypeError("operator assessment state is invalid");
	}
	if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
		throw new RangeError("operator assessment page limit is invalid");
	}
	const cursor = options.cursor ? decodeAssessmentCursor(options.cursor) : null;
	const bindings: Array<string | number> = [options.state];
	const after = cursor
		? `AND (assessment.updated_at > ?
		        OR (assessment.updated_at = ? AND assessment.run_key > ?))`
		: "";
	if (cursor) bindings.push(cursor.updatedAt, cursor.updatedAt, cursor.runKey);
	bindings.push(options.limit + 1);
	const rows = await reader.all(
		`SELECT assessment.run_key, assessment.subject_uri, assessment.subject_cid,
		        assessment.subject_kind, ${EFFECTIVE_OPERATOR_STATE_SQL} AS state,
		        assessment.state AS assessment_state, assessment.state_version,
		        assessment.policy_version, assessment.created_at, assessment.updated_at,
		        assessment.completed_at
		 FROM assessments assessment
		 LEFT JOIN operator_actions decision ON decision.id = (
		   SELECT candidate.id
		   FROM operator_actions candidate
		   WHERE candidate.subject_uri = assessment.subject_uri
		     AND candidate.subject_cid = assessment.subject_cid
		     AND candidate.action IN ('approve', 'block')
		   ORDER BY candidate.created_at DESC, candidate.id DESC
		   LIMIT 1
		 )
		 WHERE ${EFFECTIVE_OPERATOR_STATE_SQL} = ?
		   ${after}
		 ORDER BY assessment.updated_at ASC, assessment.run_key ASC
		 LIMIT ?`,
		bindings,
	);
	const items = rows.slice(0, options.limit);
	const last = items.at(-1);
	return {
		items,
		...(rows.length > options.limit && last
			? {
					nextCursor: encodeAssessmentCursor(
						requiredRowString(last, "updated_at"),
						requiredRowString(last, "run_key"),
					),
				}
			: {}),
	};
}

export async function claimRerunIdempotency(
	store: OperatorRerunActionStore,
	input: OperatorActionRecord,
): Promise<void> {
	await store.insertIfAbsent(input);
	const stored = await store.read(input.idempotencyKey);
	if (!stored || !sameRerunAction(stored, input)) {
		throw new TypeError("operator idempotency key is already bound to another action");
	}
}

function createD1OperatorRerunActionStore(db: D1Database): OperatorRerunActionStore {
	return {
		async insertIfAbsent(input) {
			await db
				.prepare(
					`INSERT INTO operator_actions
					   (actor_did, actor_role, action, subject_uri, subject_cid, reason,
					    idempotency_key, created_at)
					 VALUES (?, ?, 'rerun', ?, ?, ?, ?, ?)
					 ON CONFLICT(idempotency_key) DO NOTHING`,
				)
				.bind(
					input.actorDid,
					input.actorRole,
					input.subjectUri,
					input.subjectCid,
					input.reason,
					input.idempotencyKey,
					input.createdAt,
				)
				.run();
		},
		async read(key) {
			const row = await db
				.prepare(
					`SELECT actor_did, actor_role, action, subject_uri, subject_cid,
					        reason, idempotency_key, created_at
					 FROM operator_actions WHERE idempotency_key = ?`,
				)
				.bind(key)
				.first<{
					actor_did: string;
					actor_role: "reviewer" | "admin";
					action: string;
					subject_uri: string | null;
					subject_cid: string | null;
					reason: string;
					idempotency_key: string;
					created_at: string;
				}>();
			if (!row || row.action !== "rerun" || !row.subject_uri || !row.subject_cid) {
				return undefined;
			}
			return {
				actorDid: row.actor_did,
				actorRole: row.actor_role,
				action: "rerun",
				subjectUri: row.subject_uri,
				subjectCid: row.subject_cid,
				reason: row.reason,
				idempotencyKey: row.idempotency_key,
				createdAt: row.created_at,
			};
		},
	};
}

async function readProductionManualDecision(
	db: D1Database,
	uri: unknown,
	cid: unknown,
): Promise<OperatorManualDecisionSummary | null> {
	if (typeof uri !== "string" || typeof cid !== "string") return null;
	const row = await db
		.prepare(
			`SELECT id, action, actor_did, actor_role, reason, idempotency_key, created_at
			 FROM operator_actions
			 WHERE subject_uri = ? AND subject_cid = ? AND action IN ('approve', 'block')
			 ORDER BY created_at DESC, id DESC
			 LIMIT 1`,
		)
		.bind(uri, cid)
		.first<{
			id: number;
			action: "approve" | "block";
			actor_did: string;
			actor_role: "reviewer" | "admin";
			reason: string;
			idempotency_key: string;
			created_at: string;
		}>();
	return row
		? {
				id: row.id,
				action: row.action,
				actorDid: row.actor_did,
				actorRole: row.actor_role,
				reason: row.reason,
				idempotencyKey: row.idempotency_key,
				createdAt: row.created_at,
			}
		: null;
}

function encodeAssessmentCursor(updatedAt: string, runKey: string): string {
	return btoa(JSON.stringify([updatedAt, runKey]))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(BASE64_PADDING_RE, "");
}

function decodeAssessmentCursor(value: string): { updatedAt: string; runKey: string } {
	try {
		const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const decoded: unknown = JSON.parse(atob(padded));
		if (
			!Array.isArray(decoded) ||
			decoded.length !== 2 ||
			typeof decoded[0] !== "string" ||
			Number.isNaN(Date.parse(decoded[0])) ||
			typeof decoded[1] !== "string" ||
			decoded[1].length === 0 ||
			decoded[1].length > 200
		) {
			throw new Error();
		}
		return { updatedAt: decoded[0], runKey: decoded[1] };
	} catch {
		throw new InvalidOperatorCursorError("operator assessment cursor is invalid");
	}
}

function sameRerunAction(left: OperatorActionRecord, right: OperatorActionRecord): boolean {
	return (
		left.actorDid === right.actorDid &&
		left.actorRole === right.actorRole &&
		left.action === right.action &&
		left.subjectUri === right.subjectUri &&
		left.subjectCid === right.subjectCid &&
		left.reason === right.reason &&
		left.idempotencyKey === right.idempotencyKey
	);
}

function requiredRowString(row: Record<string, unknown>, field: string): string {
	const value = row[field];
	if (typeof value !== "string") throw new Error(`operator assessment row has invalid ${field}`);
	return value;
}

function validateMutationTransport(request: Request): Response | null {
	const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		return apiError("UNSUPPORTED_MEDIA_TYPE", "Request must be application/json", 415);
	}
	if (
		request.headers.get("origin") !== new URL(request.url).origin ||
		request.headers.get("X-EmDash-Request") !== "1"
	) {
		return apiError("CROSS_ORIGIN", "Same-origin request verification failed", 403);
	}
	const length = Number(request.headers.get("content-length"));
	if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
		return apiError("INVALID_REQUEST", "Request body is too large", 400);
	}
	return null;
}

async function parseMutationBody(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const text = await request.text();
		if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null;
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value))
			: null;
	} catch {
		return null;
	}
}

function mutationResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function parseStoredJson(value: unknown): unknown {
	if (typeof value !== "string") return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function apiError(code: string, message: string, status: number): Response {
	return Response.json(
		{ error: { code, message } },
		{ status, headers: { "cache-control": "no-store" } },
	);
}
