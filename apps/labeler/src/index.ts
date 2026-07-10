import { getLabelerConfig } from "./config.js";
import { queryLabels } from "./query-labels.js";
import { xrpcError } from "./xrpc.js";

const QUERY_LABELS_PATH = "/xrpc/com.atproto.label.queryLabels";

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
			return xrpcError("MethodNotSupported", "XRPC method not found", 404);
		}
		return new Response("emdash-labeler: not found", { status: 404 });
	},
};
