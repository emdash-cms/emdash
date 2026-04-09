/**
 * ATProto OAuth client
 *
 * Creates and configures a NodeOAuthClient for AT Protocol OAuth login.
 * Uses PKCE (public client) — no JWKS endpoint or key management needed.
 * DPoP keys are managed by the SDK internally.
 */

import { NodeOAuthClient } from "@atproto/oauth-client-node";
import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { createAtprotoSessionStore, createAtprotoStateStore } from "./stores.js";

export interface AtprotoClientOptions {
	/** Public URL of the site (e.g., "https://example.com") */
	publicUrl: string;
	/** Database instance for state/session stores */
	db: Kysely<Database>;
	/** Allow HTTP for development (default: false) */
	allowHttp?: boolean;
}

/**
 * Check if a URL is a loopback/localhost address.
 */
function isLoopback(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

/** Cached client instances keyed by publicUrl */
const clientCache = new Map<string, NodeOAuthClient>();

/**
 * Get or create an ATProto OAuth client for the given options.
 *
 * The client is cached per publicUrl since the configuration (stores, metadata)
 * doesn't change between requests. The db reference is stable (single runtime
 * connection), so stores created from it are safe to reuse.
 *
 * For production (HTTPS), the client ID is the URL of the client-metadata.json
 * endpoint, which is an ATProto convention for public clients.
 *
 * For localhost development, ATProto uses a special loopback client ID format:
 * `http://localhost?redirect_uri=...` with redirect URIs using
 * `http://127.0.0.1` (not localhost) per RFC 8252 §7.3.
 */
export function createAtprotoClient(options: AtprotoClientOptions): NodeOAuthClient {
	const { publicUrl, db, allowHttp = false } = options;

	const cached = clientCache.get(publicUrl);
	if (cached) return cached;

	const stateStore = createAtprotoStateStore(db);
	const sessionStore = createAtprotoSessionStore(db);

	let client: NodeOAuthClient;

	if (isLoopback(publicUrl)) {
		// Localhost development: use ATProto loopback client ID format.
		// Redirect URI must use 127.0.0.1, not localhost (per ATProto spec).
		const { port } = new URL(publicUrl);
		const redirectUri = `http://127.0.0.1:${port}/_emdash/api/auth/atproto/callback`;
		// Scope is "atproto" (the default), so only redirect_uri needs to be in the query
		const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}`;

		client = new NodeOAuthClient({
			clientMetadata: {
				client_id: clientId,
				client_name: "EmDash CMS",
				client_uri: publicUrl,
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				scope: "atproto",
				dpop_bound_access_tokens: true,
				application_type: "web",
			},
			stateStore,
			sessionStore,
			allowHttp: true,
		});
	} else {
		// Production: client ID is the client-metadata.json URL
		const clientId = `${publicUrl}/_emdash/api/auth/atproto/client-metadata.json`;
		const redirectUri = `${publicUrl}/_emdash/api/auth/atproto/callback`;

		client = new NodeOAuthClient({
			clientMetadata: {
				client_id: clientId,
				client_name: "EmDash CMS",
				client_uri: publicUrl,
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				scope: "atproto",
				dpop_bound_access_tokens: true,
				application_type: "web",
			},
			stateStore,
			sessionStore,
			allowHttp,
		});
	}

	clientCache.set(publicUrl, client);
	return client;
}

/**
 * Clean up expired ATProto state and session entries from auth_challenges.
 * Call periodically or after successful login.
 */
export async function cleanupAtprotoEntries(db: Kysely<Database>): Promise<void> {
	const now = new Date().toISOString();
	await db
		.deleteFrom("auth_challenges")
		.where("type", "in", ["atproto", "atproto_session", "atproto_pending"])
		.where("expires_at", "<", now)
		.execute();
}
