import { getLabelerConfig } from "./config.js";
import { queryLabels } from "./query-labels.js";
import { LABEL_SUBSCRIPTION_DO_NAME } from "./subscribe-labels.js";
import { xrpcError } from "./xrpc.js";

export { LabelSubscriptionDO } from "./subscribe-labels.js";

const QUERY_LABELS_PATH = "/xrpc/com.atproto.label.queryLabels";
const SUBSCRIBE_LABELS_PATH = "/xrpc/com.atproto.label.subscribeLabels";
const SUBSCRIBE_CURSOR = /^(?:0|[1-9]\d*)$/;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (pathname.startsWith("/xrpc/")) {
			// Require the deployment identity even though this first public route
			// is read-only, so issuance cannot be configured against another DID.
			try {
				getLabelerConfig(env);
			} catch {
				return xrpcError("InternalServerError", "labeler is not configured", 500);
			}
			if (pathname === QUERY_LABELS_PATH) return queryLabels(env.DB, request);
			if (pathname === SUBSCRIBE_LABELS_PATH) return subscribeLabels(env, request);
			return xrpcError("MethodNotSupported", "XRPC method not found", 404);
		}
		return new Response("emdash-labeler: not found", { status: 404 });
	},
};

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
