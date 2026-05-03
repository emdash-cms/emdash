/**
 * Backing Service HTTP Handler
 *
 * Runs in the Node process for production workerd deployments.
 * Receives HTTP requests from plugin workers running in workerd isolates.
 * Each request is authenticated via a per-plugin auth token.
 *
 * This is a thin wrapper around createBridgeHandler that adds:
 * - Auth token validation (extracting claims from the HMAC token)
 * - Node http.IncomingMessage -> Request conversion
 * - Response -> http.ServerResponse conversion
 *
 * The actual bridge logic (dispatch, capability enforcement, DB queries)
 * lives in bridge-handler.ts and is shared with the dev runner.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { createBridgeHandler } from "./bridge-handler.js";
import type { WorkerdSandboxRunner } from "./runner.js";

export interface BackingServiceHandler {
	handler: (req: IncomingMessage, res: ServerResponse) => void;
	removePlugin: (pluginId: string) => void;
}

/**
 * Create an HTTP request handler for the backing service.
 */
export function createBackingServiceHandler(runner: WorkerdSandboxRunner): BackingServiceHandler {
	// Cache bridge handlers per pluginId to avoid re-creation
	const handlerCache = new Map<string, (request: Request) => Promise<Response>>();
	const tokenToPluginId = new Map<string, string>();

	const handler = async (req: IncomingMessage, res: ServerResponse) => {
		try {
			// Parse auth token from Authorization header
			const authHeader = req.headers.authorization;
			if (!authHeader?.startsWith("Bearer ")) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing or invalid authorization" }));
				return;
			}

			const token = authHeader.slice(7);
			const claims = runner.validateToken(token);
			if (!claims) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid auth token" }));
				return;
			}

			// Get or create bridge handler for this plugin
			const cacheKey = claims.pluginId;
			let bridgeHandler = handlerCache.get(cacheKey);
			if (!bridgeHandler) {
				bridgeHandler = createBridgeHandler({
					pluginId: claims.pluginId,
					version: claims.version,
					capabilities: claims.capabilities,
					allowedHosts: claims.allowedHosts,
					storageCollections: claims.storageCollections,
					storageConfig: runner.getPluginStorageConfig(claims.pluginId, claims.version) as
						| Record<string, { indexes?: Array<string | string[]> }>
						| undefined,
					db: runner.db,
					emailSend: () => runner.emailSend,
					storage: runner.mediaStorage,
				});
				handlerCache.set(cacheKey, bridgeHandler);
				tokenToPluginId.set(token, cacheKey);
			}

			// Convert Node request to web Request
			const body = await readBody(req);
			const url = `http://bridge${req.url || "/"}`;
			const webRequest = new Request(url, {
				method: req.method || "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			// Dispatch through the shared bridge handler
			const webResponse = await bridgeHandler(webRequest);
			const responseBody = await webResponse.text();

			res.writeHead(webResponse.status, { "Content-Type": "application/json" });
			res.end(responseBody);
		} catch (error) {
			const statusCode =
				error instanceof Error && "statusCode" in error
					? (error as Error & { statusCode: number }).statusCode
					: 500;
			const message = error instanceof Error ? error.message : "Internal error";
			res.writeHead(statusCode, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: message }));
		}
	};

	return {
		handler,
		removePlugin(pluginId: string) {
			handlerCache.delete(pluginId);
			for (const [token, id] of tokenToPluginId) {
				if (id === pluginId) {
					tokenToPluginId.delete(token);
				}
			}
		},
	};
}

const MAX_BRIDGE_BODY_BYTES = 10 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of req) {
		totalBytes += (chunk as Buffer).length;
		if (totalBytes > MAX_BRIDGE_BODY_BYTES) {
			const err = new Error("Request body too large");
			(err as Error & { statusCode: number }).statusCode = 413;
			throw err;
		}
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks).toString();
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
