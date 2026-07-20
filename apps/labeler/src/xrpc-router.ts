/**
 * XRPC dispatcher for the labeler's public assessment read API
 * (`com.emdashcms.experimental.labeler.*`). Mirrors the aggregator's typed
 * `XRPCRouter` idiom (`apps/aggregator/src/routes/xrpc/router.ts`) — handlers
 * receive lexicon-validated `params` and return a `Response`; the router
 * handles 400 (bad params), 404 (no handler), and 500 (unexpected throw)
 * automatically, and handlers throw `XRPCError` for typed application
 * errors.
 *
 * `index.ts` intercepts the atproto label NSIDs (`queryLabels`,
 * `subscribeLabels`, `createReport`) before falling through here — this
 * router only ever sees the four `com.emdashcms.*` queries.
 *
 * Caching: unlike the aggregator's unconditional `no-store` (label state can
 * change at any time there), these are public, cacheable reads — each
 * handler sets its own `cache-control`; the wrapper only fills in a
 * `no-store` default when a handler (or the router's own error path) didn't
 * set one.
 */

import { json, XRPCError, XRPCRouter, type QueryContext } from "@atcute/xrpc-server";
import {
	LabelerGetAssessment,
	LabelerGetCurrentAssessment,
	LabelerGetPolicy,
	LabelerListAssessments,
	type LabelerDefs,
} from "@emdash-cms/registry-lexicons";

import moderationPolicy from "../fixtures/moderation-policy.json";
import {
	computeFilterHash,
	decodeCursor,
	encodeCursor,
	InvalidCursorError,
} from "./assessment-cursor.js";
import {
	getActiveLabelState,
	getAssessment,
	getAssessmentsPage,
	getCurrentAssessment,
	getLabelsForAssessment,
	getLabelsForAssessments,
	getLatestPendingAssessment,
	isSuperseded,
	subjectWasObserved,
	type Assessment,
	type AssessmentLabelOp,
	type LabelStreamWinner,
	type ListAssessmentsFilters,
} from "./assessment-store.js";
import type { LabelerConfig } from "./config.js";
import {
	derivePublicState,
	toPublicAssessment,
	type PublicLabelSummary,
} from "./public-assessment.js";
import { xrpcError } from "./xrpc.js";

const ASSESSMENT_CACHE_CONTROL = "public, max-age=60";
const POLICY_CACHE_CONTROL = "public, max-age=300";

const PUBLIC_STATES: ReadonlySet<string> = new Set([
	"pending",
	"passed",
	"warned",
	"blocked",
	"error",
	"superseded",
]);

/**
 * CORS for the labeler's public assessment reads. `*` is correct: nothing
 * in the response depends on the caller's origin or credentials — no
 * cookies, no auth. Only `content-type` is a request header any client
 * sends; there's no `atproto-content-labelers`-equivalent to expose here
 * (this labeler's own DID is fixed and known to every caller).
 */
const CORS_HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, OPTIONS",
	"access-control-allow-headers": "content-type",
	"access-control-max-age": "86400",
};

function applyCorsHeaders(headers: Headers): void {
	for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
}

function notFound(message: string): XRPCError {
	return new XRPCError({ status: 404, error: "NotFound", message });
}

function unsupportedSource(src: string): XRPCError {
	return new XRPCError({
		status: 400,
		error: "UnsupportedSource",
		message: `This labeler does not serve assessments for src ${src}.`,
	});
}

function toLabelSummaries(
	ops: readonly AssessmentLabelOp[],
	winners: ReadonlyMap<string, LabelStreamWinner>,
): PublicLabelSummary[] {
	return ops.map((op) => {
		const winner = winners.get(op.val);
		const active = winner !== undefined && winner.sequence === op.sequence && winner.active;
		return {
			val: op.val,
			active,
			issuedAt: op.cts,
			...(op.exp !== null ? { expiresAt: op.exp } : {}),
		};
	});
}

function buildPublicAssessmentView(
	config: LabelerConfig,
	row: Assessment,
	isSupersededFlag: boolean,
	ops: readonly AssessmentLabelOp[],
	winners: ReadonlyMap<string, LabelStreamWinner>,
): LabelerDefs.PublicAssessment | null {
	const publicState = derivePublicState(row.state, isSupersededFlag);
	if (publicState === null) return null;
	return toPublicAssessment(row, {
		labelerDid: config.labelerDid,
		publicState,
		labels: toLabelSummaries(ops, winners),
		reconsiderationUrl: moderationPolicy.contact.reconsiderationUrl,
	});
}

async function handleGetAssessment(
	env: Env,
	config: LabelerConfig,
	params: QueryContext<typeof LabelerGetAssessment.mainSchema>["params"],
): Promise<Response> {
	let row: Assessment | null;
	try {
		row = await getAssessment(env.DB, params.id);
	} catch (err) {
		if (err instanceof TypeError) row = null;
		else throw err;
	}
	if (!row) throw notFound(`No assessment ${params.id}.`);
	const [superseded, winners] = await Promise.all([
		isSuperseded(env.DB, row.id),
		getActiveLabelState(env.DB, { src: config.labelerDid, uri: row.uri, cid: row.cid }),
	]);
	const publicState = derivePublicState(row.state, superseded);
	if (publicState === null) throw notFound(`No assessment ${params.id}.`);
	const ops = await getLabelsForAssessment(env.DB, row.id);
	const view = toPublicAssessment(row, {
		labelerDid: config.labelerDid,
		publicState,
		labels: toLabelSummaries(ops, winners),
		reconsiderationUrl: moderationPolicy.contact.reconsiderationUrl,
	});
	return json(view, { headers: { "cache-control": ASSESSMENT_CACHE_CONTROL } });
}

function parseStateParam(state: string | undefined): string | undefined {
	if (state === undefined) return undefined;
	if (!PUBLIC_STATES.has(state))
		throw new XRPCError({
			status: 400,
			error: "InvalidRequest",
			message: `Unknown state: ${state}.`,
		});
	return state;
}

async function handleListAssessments(
	env: Env,
	config: LabelerConfig,
	params: QueryContext<typeof LabelerListAssessments.mainSchema>["params"],
): Promise<Response> {
	if (params.src !== undefined && params.src !== config.labelerDid)
		throw unsupportedSource(params.src);
	if (params.cid !== undefined && params.uri === undefined)
		throw new XRPCError({ status: 400, error: "InvalidRequest", message: "cid requires uri." });

	// `parseStateParam`'s validated return narrows to the store's known
	// public-state literals; the Set check above is the only place that
	// enforces it (the lexicon's `knownValues` is documentation, not a
	// runtime constraint — @atcute/lexicons accepts any string here).
	const filters: ListAssessmentsFilters = {
		uri: params.uri,
		cid: params.cid,
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- parseStateParam validates membership in PUBLIC_STATES above
		state: parseStateParam(params.state) as ListAssessmentsFilters["state"],
	};
	const filterHash = await computeFilterHash(filters);
	let keyset: { createdAt: string; id: string } | null;
	try {
		keyset = decodeCursor(params.cursor, filterHash);
	} catch (err) {
		if (err instanceof InvalidCursorError)
			throw new XRPCError({ status: 400, error: "InvalidCursor", message: err.message });
		throw err;
	}

	const rows = await getAssessmentsPage(env.DB, filters, keyset, params.limit);
	const hasMore = rows.length > params.limit;
	const page = hasMore ? rows.slice(0, params.limit) : rows;

	// One batched lookup for the whole page instead of one per row, so this
	// stays a fixed number of D1 round-trips regardless of page size.
	const labelOpsById = await getLabelsForAssessments(
		env.DB,
		page.map((row) => row.id),
	);
	const winnersCache = new Map<string, ReadonlyMap<string, LabelStreamWinner>>();
	const assessments: LabelerDefs.PublicAssessment[] = [];
	for (const row of page) {
		const cacheKey = JSON.stringify([row.uri, row.cid]);
		let winners = winnersCache.get(cacheKey);
		if (!winners) {
			winners = await getActiveLabelState(env.DB, {
				src: config.labelerDid,
				uri: row.uri,
				cid: row.cid,
			});
			winnersCache.set(cacheKey, winners);
		}
		const view = buildPublicAssessmentView(
			config,
			row,
			row.isSuperseded,
			labelOpsById.get(row.id) ?? [],
			winners,
		);
		// The store already excludes non-public stored states and, for a
		// single-state filter, non-matching superseded rows — a null view
		// here would mean the two disagree, not a normal empty page.
		if (view !== null) assessments.push(view);
	}

	const last = page.at(-1);
	const response: LabelerListAssessments.$output = {
		assessments,
		...(hasMore && last
			? { cursor: encodeCursor({ createdAt: last.createdAt, id: last.id }, filterHash) }
			: {}),
	};
	return json(response, { headers: { "cache-control": ASSESSMENT_CACHE_CONTROL } });
}

type ActiveLabelView = LabelerDefs.CurrentAssessmentView["activeLabels"][number];

function toActiveLabelView(src: string, uri: string, winner: LabelStreamWinner): ActiveLabelView {
	return {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- src is this deployment's own labeler DID, validated at config load
		src: src as `did:${string}:${string}`,
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- uri is lexicon-validated by the router before this handler runs
		uri: uri as ActiveLabelView["uri"],
		val: winner.val,
		cts: winner.cts,
		...(winner.cid !== null ? { cid: winner.cid } : {}),
		...(winner.exp !== null ? { exp: winner.exp } : {}),
	};
}

async function handleGetCurrentAssessment(
	env: Env,
	config: LabelerConfig,
	params: QueryContext<typeof LabelerGetCurrentAssessment.mainSchema>["params"],
): Promise<Response> {
	if (params.src !== undefined && params.src !== config.labelerDid)
		throw unsupportedSource(params.src);
	const src = config.labelerDid;

	const [pointer, pendingRow, winners] = await Promise.all([
		getCurrentAssessment(env.DB, { src, uri: params.uri, cid: params.cid }),
		getLatestPendingAssessment(env.DB, { uri: params.uri, cid: params.cid }),
		getActiveLabelState(env.DB, { src, uri: params.uri, cid: params.cid }),
	]);
	const current = pointer ? await getAssessment(env.DB, pointer.assessmentId) : null;
	const activeLabels = [...winners.values()]
		.filter((winner) => winner.active)
		.toSorted((a, b) => (a.val < b.val ? -1 : a.val > b.val ? 1 : 0))
		.map((winner) => toActiveLabelView(src, params.uri, winner));

	if (!current && !pendingRow && activeLabels.length === 0) {
		const observed = await subjectWasObserved(env.DB, { uri: params.uri, cid: params.cid });
		if (!observed) throw notFound(`Unknown subject (${params.uri}, ${params.cid}).`);
	}

	const labelOpsById = await getLabelsForAssessments(
		env.DB,
		[current?.id, pendingRow?.id].filter((id): id is string => id !== undefined),
	);

	let currentView: LabelerDefs.PublicAssessment | undefined;
	if (current) {
		const view = buildPublicAssessmentView(
			config,
			current,
			false,
			labelOpsById.get(current.id) ?? [],
			winners,
		);
		if (view !== null) currentView = view;
		else
			console.error(
				`[xrpc-router] current-assessment pointer ${current.id} has a non-public state`,
			);
	}
	let pendingView: LabelerDefs.PublicAssessment | undefined;
	if (pendingRow) {
		const view = buildPublicAssessmentView(
			config,
			pendingRow,
			false,
			labelOpsById.get(pendingRow.id) ?? [],
			winners,
		);
		if (view !== null) pendingView = view;
	}

	const view: LabelerDefs.CurrentAssessmentView = {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- src is this deployment's own labeler DID, validated at config load
		src: src as `did:${string}:${string}`,
		subject: { uri: params.uri, cid: params.cid },
		activeLabels,
		...(currentView !== undefined ? { current: currentView } : {}),
		...(pendingView !== undefined ? { pending: pendingView } : {}),
		// `override` (a manual-action publicManualAction) is always absent in
		// v1 — no manual-action storage of that shape exists yet; W10's
		// contact-resolution half is deferred pending a separate decision.
	};
	return json(view, { headers: { "cache-control": ASSESSMENT_CACHE_CONTROL } });
}

async function handleGetPolicy(config: LabelerConfig): Promise<Response> {
	if (moderationPolicy.labelerDid !== config.labelerDid) {
		throw new XRPCError({
			status: 500,
			error: "InternalServerError",
			message: "labeler policy identity does not match the deployment",
		});
	}
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the fixture's shape is the labelerPolicy contract; parseModerationPolicy validates a subset at module load and the identity check above guards deployment drift
	return json(moderationPolicy as unknown as LabelerDefs.LabelerPolicy, {
		headers: { "cache-control": POLICY_CACHE_CONTROL },
	});
}

function createRouter(env: Env, config: LabelerConfig): XRPCRouter {
	const router = new XRPCRouter({
		// The default is a plain-text 404; this router replaces the flat
		// dispatcher's blanket fallback in index.ts, which returned the same
		// JSON envelope every other XRPC error on this service uses.
		handleNotFound: () => xrpcError("MethodNotSupported", "XRPC method not found", 404),
	});
	router.addQuery(LabelerGetAssessment.mainSchema, {
		handler: ({ params }) => handleGetAssessment(env, config, params),
	});
	router.addQuery(LabelerGetCurrentAssessment.mainSchema, {
		handler: ({ params }) => handleGetCurrentAssessment(env, config, params),
	});
	router.addQuery(LabelerListAssessments.mainSchema, {
		handler: ({ params }) => handleListAssessments(env, config, params),
	});
	router.addQuery(LabelerGetPolicy.mainSchema, {
		handler: () => handleGetPolicy(config),
	});
	return router;
}

/** Cache the router per worker isolate on `globalThis` (Vite can duplicate a
 * module across chunks; a plain module-scope `let` would become two separate
 * caches). Construction registers handler closures that capture `env`/`config`;
 * both are stable across requests within an isolate so single-instance is fine. */
interface RouterCache {
	router: XRPCRouter;
	envRef: Env;
}
const ROUTER_CACHE_KEY = Symbol.for("emdash:labeler-xrpc-router");
const routerGlobal = globalThis as Record<symbol, unknown>;
function getRouter(env: Env, config: LabelerConfig): XRPCRouter {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see core request-cache.ts)
	const cached = routerGlobal[ROUTER_CACHE_KEY] as RouterCache | undefined;
	if (cached && cached.envRef === env) return cached.router;
	const router = createRouter(env, config);
	routerGlobal[ROUTER_CACHE_KEY] = { router, envRef: env };
	return router;
}

/** Dispatch a `/xrpc/*` request to the four `com.emdashcms.experimental.labeler.*`
 * queries. `index.ts` calls this only after the atproto label NSIDs have
 * already been ruled out; unknown NSIDs 404 via the router itself. */
export async function handleAssessmentXrpc(
	env: Env,
	request: Request,
	config: LabelerConfig,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		const headers = new Headers();
		applyCorsHeaders(headers);
		return new Response(null, { status: 204, headers });
	}
	const router = getRouter(env, config);
	const response = await router.fetch(request);
	const headers = new Headers(response.headers);
	if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
	applyCorsHeaders(headers);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
