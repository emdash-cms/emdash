import {
	getAccessKeyResolver,
	parseAccessAuthConfig,
	type AccessAuthConfig,
} from "./access-auth.js";
import { getLabelerIdentityConfig, type LabelerIdentityConfig } from "./config.js";
import { consoleAssetPath, handleConsoleApi, probeJetstreamConnected } from "./console-api.js";
import { handleConsoleMutation, publishAfterCommit } from "./console-mutation-api.js";
import { drainDiscoveryDeadLetterBatch, processDiscoveryBatch } from "./discovery-consumer.js";
import { LABELER_DISCOVERY_DO_NAME } from "./discovery-do.js";
import type { DiscoveryJob } from "./env.js";
import { didDocumentResponse, policyDocumentResponse } from "./identity.js";
import { handleNotificationRequest, isNotificationPath } from "./notification-endpoints.js";
import { runNotificationSweep } from "./notification-sweep.js";
import { createNotifyDeps, type NotifyDeps } from "./notification-triggers.js";
import { runProlongedErrorEscalation } from "./prolonged-error.js";
import { queryLabels } from "./query-labels.js";
import { reconcileAssessments } from "./reconciliation.js";
import { createRuntimeSigner, getRuntimeSigningSecret } from "./signing-runtime.js";
import { LABEL_SUBSCRIPTION_DO_NAME } from "./subscribe-labels.js";
import { handleAssessmentXrpc } from "./xrpc-router.js";
import { xrpcError } from "./xrpc.js";

export { AssessmentWorkflow } from "./assessment-workflow.js";
export { LabelerDiscoveryDO } from "./discovery-do.js";
export { LabelSubscriptionDO } from "./subscribe-labels.js";

const QUERY_LABELS_PATH = "/xrpc/com.atproto.label.queryLabels";
const SUBSCRIBE_LABELS_PATH = "/xrpc/com.atproto.label.subscribeLabels";
const CREATE_REPORT_PATH = "/xrpc/com.atproto.moderation.createReport";
const DID_DOCUMENT_PATH = "/.well-known/did.json";
const POLICY_DOCUMENT_PATH = "/.well-known/emdash-labeler-policy.json";
const SUBSCRIBE_CURSOR = /^(?:0|[1-9]\d*)$/;
const DISCOVERY_QUEUE_NAME = "emdash-labeler-discovery";
const DISCOVERY_DLQ_NAME = "emdash-labeler-discovery-dlq";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		let config;
		try {
			config = await getLabelerIdentityConfig(env);
		} catch {
			if (pathname.startsWith("/xrpc/"))
				return xrpcError("InternalServerError", "labeler is not configured", 500);
			return new Response("emdash-labeler is not configured", { status: 500 });
		}
		if (pathname === DID_DOCUMENT_PATH) return didDocumentResponse(request, config);
		if (pathname === POLICY_DOCUMENT_PATH) return policyDocumentResponse(request, config);
		if (pathname.startsWith("/xrpc/")) {
			if (pathname === QUERY_LABELS_PATH)
				return queryLabels(env.DB, request, () =>
					createRuntimeSigner(config, getRuntimeSigningSecret(env)),
				);
			if (pathname === SUBSCRIBE_LABELS_PATH) return subscribeLabels(env, request);
			if (pathname === CREATE_REPORT_PATH) return rejectModerationReport(request);
			return handleAssessmentXrpc(env, request, config);
		}
		// Public publisher-notification landing pages (confirm / unsubscribe /
		// not-me). Mounted outside `/admin/*` so the Access edge policy and the
		// operator guard never apply — the capability in the link is the sole
		// authority (see notification-endpoints.ts).
		if (isNotificationPath(pathname)) return handleNotificationRequest(env.DB, request);
		// `/admin/api/*` is the Access-guarded operator read API; anything else
		// under `/admin` is the console SPA, served (with SPA deep-link
		// fallback) by the assets binding. The Access edge policy on `/admin/*`
		// redirects an unauthenticated browser before it reaches the Worker, so
		// the shell needs no in-Worker auth check — the API re-verifies per
		// request regardless (see console-api.ts / operator-read-guard.ts).
		if (pathname === "/admin/api" || pathname.startsWith("/admin/api/"))
			return handleConsoleApiRequest(env, request, config, ctx);
		const assetPath = consoleAssetPath(pathname);
		if (assetPath !== null) {
			const assetUrl = new URL(request.url);
			assetUrl.pathname = assetPath;
			return env.ASSETS.fetch(new Request(assetUrl, request));
		}
		return new Response("emdash-labeler: not found", { status: 404 });
	},

	async queue(batch: MessageBatch, env: Env): Promise<void> {
		switch (batch.queue) {
			case DISCOVERY_QUEUE_NAME:
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by queue name
				await processDiscoveryBatch(batch as MessageBatch<DiscoveryJob>, env);
				return;
			case DISCOVERY_DLQ_NAME:
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by queue name
				await drainDiscoveryDeadLetterBatch(batch as MessageBatch<DiscoveryJob>, env);
				return;
			default:
				console.error("[labeler] unknown queue, acking batch", { queue: batch.queue });
				for (const m of batch.messages) m.ack();
		}
	},

	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		// DO liveness (same rationale as the aggregator's records DO — it
		// holds an outbound Jetstream WebSocket and can be evicted mid-backoff
		// during an outage).
		const id = env.LABELER_DISCOVERY_DO.idFromName(LABELER_DISCOVERY_DO_NAME);
		const stub = env.LABELER_DISCOVERY_DO.get(id);
		ctx.waitUntil(stub.fetch("https://do.internal/liveness"));

		// Minimal reconciliation (plan W6.8): stuck runs + orphaned subjects.
		ctx.waitUntil(
			reconcileAssessments(env.DB, new Date()).catch((err: unknown) => {
				console.error("[labeler] reconciliation pass failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}),
		);

		// Publisher-notification retry sweep (plan W10.5): re-drive failed /
		// crash-stuck sends, abandon the exhausted, prune terminal rows. Isolated in
		// its own branch so a sweep failure never disturbs the passes above.
		ctx.waitUntil(
			(async () => {
				try {
					await runNotificationSweep(await createNotifyDeps(env));
				} catch (err) {
					console.error("[labeler] notification sweep failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			})(),
		);

		// Prolonged-error escalation (plan W10.5 follow-up): 24h operator alert then
		// 72h publisher notice for an errored, unsuperseded run. Its own branch with
		// the non-throwing deps builder, so a notify-deps failure skips the pass
		// rather than disturbing the sweep or reconciliation passes above.
		ctx.waitUntil(
			(async () => {
				try {
					const deps = await safeCreateNotifyDeps(env);
					if (!deps) return;
					await runProlongedErrorEscalation(deps, new Date());
				} catch (err) {
					console.error("[labeler] prolonged-error escalation failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			})(),
		);
	},
};

const OPERATOR_ACCESS_CONFIG_CACHE_KEY = Symbol.for("emdash-labeler:operator-access-config");

/** Parse `OPERATOR_ACCESS_CONFIG` (a JSON string var) once and cache the result
 * on `globalThis` — Vite can duplicate this module across SSR chunks, so a
 * plain module-scope binding would parse per chunk. */
function getOperatorAccessConfig(env: Env): AccessAuthConfig {
	const g = globalThis as Record<symbol, unknown>;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern
	const cached = g[OPERATOR_ACCESS_CONFIG_CACHE_KEY] as AccessAuthConfig | undefined;
	if (cached) return cached;
	const parsed = parseAccessAuthConfig(JSON.parse(env.OPERATOR_ACCESS_CONFIG));
	g[OPERATOR_ACCESS_CONFIG_CACHE_KEY] = parsed;
	return parsed;
}

/** Build notify deps for the console mutation path without ever throwing: a
 * failure (e.g. a missing hash pepper) degrades notifications to `undefined` so
 * the label mutation still commits. Notifications are a post-commit side effect
 * and must never block a label action. */
export async function safeCreateNotifyDeps(env: Env): Promise<NotifyDeps | undefined> {
	try {
		return await createNotifyDeps(env);
	} catch (err) {
		console.error("[notifications] notify deps unavailable; skipping notifications", {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

async function handleConsoleApiRequest(
	env: Env,
	request: Request,
	config: LabelerIdentityConfig,
	ctx: ExecutionContext,
): Promise<Response> {
	let accessConfig: AccessAuthConfig;
	try {
		accessConfig = getOperatorAccessConfig(env);
	} catch {
		return Response.json(
			{ error: { code: "NOT_CONFIGURED", message: "Operator console is not configured" } },
			{ status: 500 },
		);
	}
	const keys = getAccessKeyResolver(accessConfig.teamDomain);
	if (request.method === "POST") {
		return handleConsoleMutation(request, {
			db: env.DB,
			accessConfig,
			keys,
			config,
			createSigner: async () =>
				(await createRuntimeSigner(config, getRuntimeSigningSecret(env))).signer,
			now: () => new Date(),
			afterCommit: (actionId) => publishAfterCommit(env, actionId),
			defer: (work) => ctx.waitUntil(work),
			sendDiscoveryJob: async (job) => {
				await env.DISCOVERY_QUEUE.send(job);
			},
			notify: await safeCreateNotifyDeps(env),
		});
	}
	return handleConsoleApi(request, {
		db: env.DB,
		config: accessConfig,
		keys,
		labelerDid: config.labelerDid,
		jetstreamConnected: () => probeJetstreamConnected(env),
	});
}

function rejectModerationReport(request: Request): Response {
	if (request.method !== "POST")
		return xrpcError("MethodNotSupported", "createReport only supports POST", 405, {
			allow: "POST",
		});
	return xrpcError("NotSupported", "This labeler does not accept moderation reports", 501);
}

async function subscribeLabels(env: Env, request: Request): Promise<Response> {
	if (request.method !== "GET")
		return xrpcError("MethodNotSupported", "subscribeLabels only supports GET", 405, {
			allow: "GET",
		});
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
		return xrpcError("InvalidRequest", "subscribeLabels requires a WebSocket upgrade", 426);
	const cursor = new URL(request.url).searchParams.getAll("cursor");
	if (cursor.length > 1 || (cursor[0] !== undefined && !SUBSCRIBE_CURSOR.test(cursor[0])))
		return xrpcError("InvalidRequest", "cursor must be a non-negative integer", 400);
	return env.LABEL_SUBSCRIPTION.getByName(LABEL_SUBSCRIPTION_DO_NAME).fetch(request);
}
