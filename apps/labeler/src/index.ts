import { getLabelerIdentityConfig } from "./config.js";
import { didDocumentResponse, policyDocumentResponse } from "./identity.js";
import { queryLabels } from "./query-labels.js";
import { createRuntimeSigner, getRuntimeSigningSecret } from "./signing-runtime.js";
import { LABEL_SUBSCRIPTION_DO_NAME } from "./subscribe-labels.js";
import { xrpcError } from "./xrpc.js";

export { LabelSubscriptionDO } from "./subscribe-labels.js";

const QUERY_LABELS_PATH = "/xrpc/com.atproto.label.queryLabels";
const SUBSCRIBE_LABELS_PATH = "/xrpc/com.atproto.label.subscribeLabels";
const CREATE_REPORT_PATH = "/xrpc/com.atproto.moderation.createReport";
const DID_DOCUMENT_PATH = "/.well-known/did.json";
const POLICY_DOCUMENT_PATH = "/.well-known/emdash-labeler-policy.json";
const SUBSCRIBE_CURSOR = /^(?:0|[1-9]\d*)$/;

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
			return xrpcError("MethodNotSupported", "XRPC method not found", 404);
		}
		return new Response("emdash-labeler: not found", { status: 404 });
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
