import { getLabelerIdentityConfig } from "./config.js";
import { drainDiscoveryDeadLetterBatch, processDiscoveryBatch } from "./discovery-consumer.js";
import { LABELER_DISCOVERY_DO_NAME } from "./discovery-do.js";
import type { DiscoveryJob } from "./env.js";
import { didDocumentResponse, policyDocumentResponse } from "./identity.js";
import { queryLabels } from "./query-labels.js";
import { reconcileAssessments } from "./reconciliation.js";
import { createRuntimeSigner, getRuntimeSigningSecret } from "./signing-runtime.js";
import { LABEL_SUBSCRIPTION_DO_NAME } from "./subscribe-labels.js";
import { handleAssessmentXrpc } from "./xrpc-router.js";
import { xrpcError } from "./xrpc.js";

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
	async fetch(request: Request, env: Env): Promise<Response> {
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
	},
};

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
