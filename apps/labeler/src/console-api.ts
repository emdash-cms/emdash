/**
 * Operator console read API (plan W9.3). Dispatches the seven Access-guarded,
 * read-only `/admin/api/*` routes the console's `createFetchClient` consumes.
 * Mirrors `xrpc-router.ts`'s hand-rolled dispatch + pure-D1-read style; each
 * route is `guardRead` (once, at the top — every route requires the same
 * reviewer gate) → store read → serialize → `{ data }`.
 *
 * Confidentiality of the private-evidence responses rests on: the edge Access
 * policy on `/admin/*`, the per-request `verifyAccessRequest` + reviewer gate in
 * `guardRead`, and — load-bearing, carried from W9.2 verbatim — **never emitting
 * any `Access-Control-Allow-*` header**. A forged cross-origin GET can at most
 * trigger a harmless read; without a CORS allow-origin the browser refuses to
 * expose the body. No route here sets a CORS header.
 */

import type { OperatorIdentity } from "./access-auth.js";
import {
	computeFilterHash,
	decodeCursor,
	encodeCursor,
	InvalidCursorError,
} from "./assessment-cursor.js";
import {
	countInFlightAssessments,
	getActiveLabelState,
	getAllLabelsForAssessment,
	getAssessment,
	getAssessmentsForUri,
	getAssessmentsPage,
	getCurrentSubjectByUri,
	getFindingsForAssessment,
	isSuperseded,
	type ListAssessmentsFilters,
	type ListedAssessment,
} from "./assessment-store.js";
import {
	serializeAssessmentRun,
	serializeIssuedLabel,
	serializeOperatorActionView,
	serializeOperatorFinding,
	serializeSubjectLabel,
	serializeSubjectRecord,
	type Page,
} from "./console-serialize.js";
import { LABELER_DISCOVERY_DO_NAME } from "./discovery-do.js";
import { computeEffectPreview, computeOverrideEffectPreview } from "./label-effect-preview.js";
import { MutationGuardError } from "./mutation-guard.js";
import { getOperatorActionsPage } from "./operator-actions.js";
import { guardRead, ReadGuardError, type ReadGuardDeps } from "./operator-read-guard.js";
import { assertNegatableBlockSet, NegatableBlockSetError } from "./service.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const NON_NEGATIVE_INTEGER = /^\d+$/;
const ADMIN_API_PREFIX = /^\/admin\/api\/?/;

const PUBLIC_STATES: ReadonlySet<string> = new Set([
	"pending",
	"passed",
	"warned",
	"blocked",
	"error",
	"superseded",
]);

export interface ConsoleApiDeps extends ReadGuardDeps {
	db: D1Database;
	labelerDid: string;
	/** Resolves the operator dashboard's `jetstreamConnected` flag (a discovery
	 * DO round-trip with a D1 freshness fallback). Injected so the dispatcher
	 * stays unit-testable without a live DO. */
	jetstreamConnected: () => Promise<boolean>;
}

/**
 * Serves a `/admin/api/*` request. The caller (index.ts) has already matched the
 * prefix; unmatched sub-paths 404 here. Every request is reviewer-gated before
 * any store read runs.
 */
export async function handleConsoleApi(request: Request, deps: ConsoleApiDeps): Promise<Response> {
	try {
		const identity = await guardRead(request, deps, { minRole: "reviewer" });
		// `matchRoute` is synchronous, so a rejection from the handler is consumed
		// by this `await` directly — never adopted by an intermediate async layer,
		// which would surface a spurious unhandled rejection under workerd.
		const handler = matchRoute(request, deps, identity);
		const response = await handler();
		return response;
	} catch (error) {
		if (error instanceof MutationGuardError || error instanceof ReadGuardError)
			return error.toResponse();
		console.error("[console-api] unhandled error", error);
		return Response.json(
			{ error: { code: "INTERNAL", message: "Internal error" } },
			{ status: 500 },
		);
	}
}

function matchRoute(
	request: Request,
	deps: ConsoleApiDeps,
	identity: OperatorIdentity,
): () => Promise<Response> {
	const url = new URL(request.url);
	// pathname keeps percent-encoding; the subject URI segment is decoded per route.
	const segments = url.pathname.replace(ADMIN_API_PREFIX, "").split("/").filter(Boolean);

	if (segments[0] === "assessments") {
		if (segments.length === 1) return () => handleListAssessments(request, url, deps);
		const id = segments[1];
		if (id !== undefined && segments.length === 2)
			return () => handleGetAssessment(request, deps, id);
		if (id !== undefined && segments.length === 3 && segments[2] === "findings")
			return () => handleListFindings(request, deps, id);
		if (id !== undefined && segments.length === 3 && segments[2] === "labels")
			return () => handleListLabels(request, deps, id);
	} else if (segments[0] === "subjects" && segments[1] !== undefined) {
		const uri = decodeSubjectUri(segments[1]);
		if (segments.length === 2) return () => handleGetSubjectHistory(request, deps, uri);
		if (segments.length === 3 && segments[2] === "labels")
			return () => handleGetSubjectLabels(request, url, deps, uri);
	} else if (segments[0] === "audit-log" && segments.length === 1) {
		return () => handleListAuditLog(request, url, deps);
	} else if (segments[0] === "status" && segments.length === 1) {
		return () => handleGetStatus(request, deps);
	} else if (segments[0] === "whoami" && segments.length === 1) {
		return () => handleWhoami(request, identity);
	} else if (segments[0] === "labels" && segments.length === 2) {
		if (segments[1] === "effect-preview") return () => handleEffectPreview(request, url, deps);
		if (segments[1] === "override-effect-preview")
			return () => handleOverrideEffectPreview(request, url, deps);
	}

	throw new ReadGuardError("NOT_FOUND");
}

function requireGet(request: Request): void {
	if (request.method !== "GET") throw new ReadGuardError("METHOD_NOT_ALLOWED");
}

function decodeSubjectUri(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw new ReadGuardError("INVALID_REQUEST");
	}
}

function jsonData<T>(data: T): Response {
	// Operator data is private and volatile — never cached, never CORS-exposed.
	return Response.json({ data }, { headers: { "cache-control": "no-store" } });
}

function parseLimit(params: URLSearchParams): number {
	const raw = params.get("limit");
	if (raw === null) return DEFAULT_LIMIT;
	if (!NON_NEGATIVE_INTEGER.test(raw)) throw new ReadGuardError("INVALID_REQUEST");
	return Math.min(Math.max(Number(raw), 1), MAX_LIMIT);
}

function parseState(params: URLSearchParams): ListAssessmentsFilters["state"] {
	const raw = params.get("state");
	if (raw === null) return undefined;
	if (!PUBLIC_STATES.has(raw)) throw new ReadGuardError("INVALID_REQUEST");
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- validated against PUBLIC_STATES above
	return raw as ListAssessmentsFilters["state"];
}

function decodeReadCursor(
	raw: string | null,
	filterHash: string,
): { createdAt: string; id: string } | null {
	try {
		return decodeCursor(raw ?? undefined, filterHash);
	} catch (error) {
		if (error instanceof InvalidCursorError) throw new ReadGuardError("INVALID_CURSOR");
		throw error;
	}
}

async function handleListAssessments(
	request: Request,
	url: URL,
	deps: ConsoleApiDeps,
): Promise<Response> {
	requireGet(request);
	const filters: ListAssessmentsFilters = { state: parseState(url.searchParams) };
	const limit = parseLimit(url.searchParams);
	const filterHash = await computeFilterHash({ state: filters.state });
	const keyset = decodeReadCursor(url.searchParams.get("cursor"), filterHash);

	const rows = await getAssessmentsPage(deps.db, filters, keyset, limit);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page.at(-1);
	const body: Page<ReturnType<typeof serializeAssessmentRun>> = {
		items: page.map(serializeAssessmentRun),
		...(hasMore && last
			? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }, filterHash) }
			: {}),
	};
	return jsonData(body);
}

async function handleGetAssessment(
	request: Request,
	deps: ConsoleApiDeps,
	id: string,
): Promise<Response> {
	requireGet(request);
	let row;
	try {
		row = await getAssessment(deps.db, id);
	} catch (error) {
		// getAssessment throws TypeError on a malformed id; the client maps 404 → null.
		if (error instanceof TypeError) throw new ReadGuardError("NOT_FOUND");
		throw error;
	}
	if (!row) throw new ReadGuardError("NOT_FOUND");
	const superseded = await isSuperseded(deps.db, row.id);
	const listed: ListedAssessment = { ...row, isSuperseded: superseded };
	return jsonData(serializeAssessmentRun(listed));
}

async function handleListFindings(
	request: Request,
	deps: ConsoleApiDeps,
	assessmentId: string,
): Promise<Response> {
	requireGet(request);
	const findings = await getFindingsForAssessment(deps.db, assessmentId);
	return jsonData(findings.map(serializeOperatorFinding));
}

async function handleListLabels(
	request: Request,
	deps: ConsoleApiDeps,
	assessmentId: string,
): Promise<Response> {
	requireGet(request);
	const labels = await getAllLabelsForAssessment(deps.db, assessmentId);
	return jsonData(labels.map(serializeIssuedLabel));
}

async function handleGetSubjectHistory(
	request: Request,
	deps: ConsoleApiDeps,
	uri: string,
): Promise<Response> {
	requireGet(request);
	const subject = await getCurrentSubjectByUri(deps.db, uri);
	if (!subject) throw new ReadGuardError("NOT_FOUND");
	const assessments = await getAssessmentsForUri(deps.db, uri);
	return jsonData({
		subject: serializeSubjectRecord(subject),
		assessments: assessments.map(serializeAssessmentRun),
	});
}

/**
 * Active label state for a subject `(labelerDid, uri)` at a CID — the current
 * stream winner per value, including the manual/override labels that carry no
 * `assessment_id` and so never surface in the assessment-scoped label list. The
 * CID is `?cid=` or falls back to the current observed subject CID; a URI never
 * observed (and no CID given) is a 404, matching the subject-history route.
 */
async function handleGetSubjectLabels(
	request: Request,
	url: URL,
	deps: ConsoleApiDeps,
	uri: string,
): Promise<Response> {
	requireGet(request);
	const cidParam = url.searchParams.get("cid");
	if (cidParam !== null && cidParam.length === 0) throw new ReadGuardError("INVALID_REQUEST");
	let cid = cidParam ?? undefined;
	if (cid === undefined) {
		const subject = await getCurrentSubjectByUri(deps.db, uri);
		if (!subject) throw new ReadGuardError("NOT_FOUND");
		cid = subject.cid;
	}
	const winners = await getActiveLabelState(deps.db, {
		src: deps.labelerDid,
		uri,
		cid,
		now: new Date(),
	});
	return jsonData(Array.from(winners.values(), serializeSubjectLabel));
}

async function handleListAuditLog(
	request: Request,
	url: URL,
	deps: ConsoleApiDeps,
): Promise<Response> {
	requireGet(request);
	const limit = parseLimit(url.searchParams);
	const filterHash = await computeFilterHash({});
	const keyset = decodeReadCursor(url.searchParams.get("cursor"), filterHash);

	const rows = await getOperatorActionsPage(deps.db, keyset, limit);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page.at(-1);
	const body: Page<ReturnType<typeof serializeOperatorActionView>> = {
		items: page.map(serializeOperatorActionView),
		...(hasMore && last
			? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }, filterHash) }
			: {}),
	};
	return jsonData(body);
}

async function handleGetStatus(request: Request, deps: ConsoleApiDeps): Promise<Response> {
	requireGet(request);
	const [pendingAssessments, deadLetterDepth, jetstreamConnected] = await Promise.all([
		countInFlightAssessments(deps.db),
		countDeadLetters(deps.db),
		deps.jetstreamConnected(),
	]);
	return jsonData({
		labelerDid: deps.labelerDid,
		jetstreamConnected,
		pendingAssessments,
		deadLetterDepth,
	});
}

/** The caller's own verified identity — kind, principal, and roles — for the
 * console's cosmetic button gating. The server remains the enforcement boundary
 * (`guardMutation`'s role gate); hiding a button never grants anything. */
async function handleWhoami(request: Request, identity: OperatorIdentity): Promise<Response> {
	requireGet(request);
	const principal = identity.kind === "human" ? identity.email : identity.commonName;
	return jsonData({
		kind: identity.kind,
		principal,
		sub: identity.sub,
		roles: identity.roles,
	});
}

async function handleEffectPreview(
	request: Request,
	url: URL,
	deps: ConsoleApiDeps,
): Promise<Response> {
	requireGet(request);
	const uri = url.searchParams.get("uri");
	const val = url.searchParams.get("val");
	if (uri === null || uri.length === 0 || val === null || val.length === 0)
		throw new ReadGuardError("INVALID_REQUEST");
	const cid = url.searchParams.get("cid") ?? undefined;
	if (cid !== undefined && cid.length === 0) throw new ReadGuardError("INVALID_REQUEST");
	const neg = parseNeg(url.searchParams.get("neg"));

	const preview = await computeEffectPreview(
		deps.db,
		deps.labelerDid,
		{ uri, val, ...(cid === undefined ? {} : { cid }), neg },
		new Date(),
	);
	// An unknown label value has no policy definition to preview.
	if (!preview) throw new ReadGuardError("INVALID_REQUEST");
	return jsonData(preview);
}

/** Multi-overlay override preview: `?uri=&cid=&negate=v1&negate=v2` grounds the
 * post-override release state (blocked → eligible-manual-override) the reviewer
 * confirms before submitting. The `negate` set is validated against the live
 * negatable set with the same check the submit endpoint runs, so the preview
 * can never render an outcome the submit would reject. */
async function handleOverrideEffectPreview(
	request: Request,
	url: URL,
	deps: ConsoleApiDeps,
): Promise<Response> {
	requireGet(request);
	const uri = url.searchParams.get("uri");
	const cid = url.searchParams.get("cid");
	if (uri === null || uri.length === 0 || cid === null || cid.length === 0)
		throw new ReadGuardError("INVALID_REQUEST");
	const negate = url.searchParams.getAll("negate");
	if (negate.some((val) => val.length === 0)) throw new ReadGuardError("INVALID_REQUEST");
	try {
		await assertNegatableBlockSet(deps.db, deps.labelerDid, { uri, cid }, negate);
	} catch (error) {
		if (error instanceof NegatableBlockSetError) throw new ReadGuardError("INVALID_REQUEST");
		throw error;
	}

	const preview = await computeOverrideEffectPreview(
		deps.db,
		deps.labelerDid,
		{ uri, cid, negate },
		new Date(),
	);
	// A non-release subject (or one never observed) has no override to preview.
	if (!preview) throw new ReadGuardError("INVALID_REQUEST");
	return jsonData(preview);
}

function parseNeg(raw: string | null): boolean {
	if (raw === null || raw === "false") return false;
	if (raw === "true") return true;
	throw new ReadGuardError("INVALID_REQUEST");
}

/** Dead-letter backlog — the observable stand-in for discovery-queue depth,
 * which the Queues API does not expose to the consumer Worker (spec §11.1's
 * `/admin/system` "queue/DLQ health"). */
async function countDeadLetters(db: D1Database): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS n FROM dead_letters`).first<{ n: number }>();
	return row?.n ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Maps an `/admin` console request path onto the asset binding's namespace, or
 * returns `null` when the path is not a console asset request. The binding serves
 * `./dist/console` one-to-one from the root, but the SPA is built with
 * `base: "/admin/"`, so its `index.html` references `/admin/assets/*`. Without
 * this strip the binding resolves those against `dist/console/admin/*`, misses,
 * and hands every JS/CSS request the SPA `index.html` fallback — the shell would
 * load but never execute. `/admin` and `/admin/` map to `/` (the shell); a deep
 * link like `/admin/assessments/x` maps to `/assessments/x` (no such file, so the
 * SPA fallback correctly serves the shell). `/admin/api/*` is the read API,
 * dispatched before the asset branch, and is excluded here so an asset rewrite
 * can never swallow an API path regardless of call order.
 */
export function consoleAssetPath(pathname: string): string | null {
	if (pathname === "/admin/api" || pathname.startsWith("/admin/api/")) return null;
	if (pathname !== "/admin" && !pathname.startsWith("/admin/")) return null;
	const rest = pathname.slice("/admin".length);
	return rest === "" ? "/" : rest;
}

/**
 * `jetstreamConnected` probe (index.ts glue). Primary signal: the discovery
 * DO's `{ cursor, consecutiveFailures }` status (`0` failures ⇒ connected).
 * Fallback when the DO is unreachable/evicted: whether the D1 `ingest_state`
 * jetstream cursor was written within the last 15 minutes — the comparison runs
 * in SQLite so the `datetime('now')` string format never round-trips through JS.
 */
export async function probeJetstreamConnected(env: Env): Promise<boolean> {
	try {
		const id = env.LABELER_DISCOVERY_DO.idFromName(LABELER_DISCOVERY_DO_NAME);
		const response = await env.LABELER_DISCOVERY_DO.get(id).fetch("https://do.internal/status");
		const body: unknown = await response.json();
		if (isRecord(body) && typeof body.consecutiveFailures === "number")
			return body.consecutiveFailures === 0;
	} catch {
		// falls through to the D1 freshness fallback
	}
	try {
		const fresh = await env.DB.prepare(
			`SELECT 1 FROM ingest_state
			 WHERE source = 'jetstream' AND updated_at >= datetime('now', '-15 minutes')
			 LIMIT 1`,
		).first();
		return fresh !== null;
	} catch {
		// Neither signal is reachable; report disconnected rather than throwing and
		// failing the whole status route on a degraded observability field.
		return false;
	}
}
