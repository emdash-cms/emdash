/**
 * AT Protocol OAuth Client
 *
 * Creates and manages the @atcute/oauth-node-client OAuthClient instance
 * for AT Protocol PDS authentication.
 *
 * The OAuthClient handles all atproto-specific OAuth complexity:
 * - DPoP (proof-of-possession tokens)
 * - PAR (Pushed Authorization Requests)
 * - PKCE (Proof Key for Code Exchange)
 * - Session management with automatic token refresh
 * - Actor resolution (handle → DID → PDS)
 *
 * Uses a public client with PKCE in all environments. Per the AT Protocol
 * OAuth spec, public clients have a 2-week session lifetime cap (vs unlimited
 * for confidential clients), which is acceptable for a CMS admin panel.
 * This avoids the complexity of key management, JWKS endpoints, and
 * client assertion signing that confidential clients require.
 *
 * In dev (http://localhost), uses a loopback client per RFC 8252 — no client
 * metadata endpoint needed. In production (HTTPS), the PDS fetches the
 * client metadata document to verify the client.
 */

import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import {
	MemoryStore,
	OAuthClient,
	type OAuthSession,
	type StoredSession,
	type StoredState,
} from "@atcute/oauth-node-client";
import type { Kysely } from "kysely";

import { createDbStore } from "./db-store.js";

type Did = `did:${string}:${string}`;

// Singleton OAuthClient instance (lazily created).
// On Workers, the db binding changes per request, so we store a mutable
// reference that DB-backed stores read via a getter.
let _client: OAuthClient | null = null;
let _clientBaseUrl: string | null = null;
let _currentDb: Kysely<unknown> | null = null;
let _clientHasDb = false;

function isLoopback(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
	} catch {
		return false;
	}
}

/**
 * Get or create the AT Protocol OAuth client.
 *
 * The client is lazily initialized on first use and cached as a singleton.
 * The baseUrl must be the public-facing URL of the EmDash site
 * (used for client_id and redirect_uri).
 *
 * Uses a public client with PKCE in all environments:
 * - Loopback (localhost/127.0.0.1): No client metadata needed — PDS derives
 *   metadata from client_id URL parameters per RFC 8252.
 * - Production (HTTPS): PDS fetches the client metadata document to verify
 *   the client. No JWKS or key management needed.
 *
 * @param db - Database instance for persistent OAuth state/session storage.
 *             Required for multi-instance deployments (e.g., Workers).
 *             Pass `null` to use in-memory storage (dev only).
 */
export async function getAtprotoOAuthClient(
	baseUrl: string,
	db?: Kysely<unknown> | null,
): Promise<OAuthClient> {
	// Normalize localhost ↔ 127.0.0.1 so the singleton survives the OAuth
	// round-trip (authorize uses localhost, callback arrives on 127.0.0.1).
	if (isLoopback(baseUrl)) {
		baseUrl = baseUrl.replace("://localhost", "://127.0.0.1");
	}

	// Update the mutable db reference so cached DB-backed stores use
	// the current request's binding (critical on Workers).
	if (db) _currentDb = db;

	// Return cached client if baseUrl matches and store backend hasn't upgraded.
	// If the cached client uses MemoryStore but a db is now available, recreate
	// with DB-backed stores so state survives across Workers requests.
	if (_client && _clientBaseUrl === baseUrl && (!db || _clientHasDb)) {
		return _client;
	}

	const actorResolver = new LocalActorResolver({
		handleResolver: new CompositeHandleResolver({
			methods: {
				dns: new DohJsonHandleResolver({ dohUrl: "https://cloudflare-dns.com/dns-query" }),
				http: new WellKnownHandleResolver(),
			},
		}),
		didDocumentResolver: new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver(),
				web: new WebDidDocumentResolver(),
			},
		}),
	});

	// Use database-backed stores when a db is provided (required for
	// multi-instance deployments like Cloudflare Workers where in-memory
	// state doesn't survive across requests). Fall back to MemoryStore
	// for local dev where the singleton process persists.
	const getDb = () => _currentDb!;
	const stores = db
		? {
				sessions: createDbStore<Did, StoredSession>(getDb, "sessions"),
				states: createDbStore<string, StoredState>(getDb, "states"),
			}
		: {
				sessions: new MemoryStore<Did, StoredSession>(),
				states: new MemoryStore<string, StoredState>(),
			};

	let client: OAuthClient;

	if (isLoopback(baseUrl)) {
		// Loopback public client for local development.
		// AT Protocol spec allows loopback IPs with public clients.
		// No client metadata endpoints needed — the PDS derives
		// metadata from the client_id URL parameters.
		// baseUrl is already normalized to 127.0.0.1 above (RFC 8252).
		client = new OAuthClient({
			metadata: {
				redirect_uris: [`${baseUrl}/_emdash/api/auth/atproto/callback`],
				scope: "atproto transition:generic",
			},
			stores,
			actorResolver,
		});
	} else {
		// Public client for production (HTTPS).
		// Uses PKCE for security — no client secret or key management needed.
		// The PDS fetches the client metadata document to verify redirect_uris.
		client = new OAuthClient({
			metadata: {
				client_id: `${baseUrl}/.well-known/atproto-client-metadata.json`,
				redirect_uris: [`${baseUrl}/_emdash/api/auth/atproto/callback`],
				scope: "atproto transition:generic",
			},
			stores,
			actorResolver,
		});
	}

	_client = client;
	_clientBaseUrl = baseUrl;
	_clientHasDb = !!db;

	return client;
}

/**
 * Resolve an AT Protocol user's display name and handle from their PDS.
 *
 * Uses the authenticated session to call com.atproto.repo.getRecord
 * for the app.bsky.actor.profile record. Returns displayName and handle
 * (falls back to DID if resolution fails).
 */
export async function resolveAtprotoProfile(
	atprotoSession: OAuthSession,
): Promise<{ displayName: string | null; handle: string }> {
	const did = atprotoSession.did;

	// Resolve handle and displayName as independent best-effort steps.
	// Handle comes from getSession (authoritative PDS record).
	// DisplayName comes from the profile record (optional, cosmetic).
	let handle: string = did;
	let displayName: string | null = null;

	// 1. Handle via getSession (needed for allowlist checks — fetch independently)
	try {
		const sessionRes = await atprotoSession.handle("/xrpc/com.atproto.server.getSession");
		if (sessionRes.ok) {
			const sessionData = (await sessionRes.json()) as { handle?: string };
			if (sessionData.handle) handle = sessionData.handle;
		}
	} catch (error) {
		console.warn("[atproto-auth] Failed to resolve handle via getSession:", error);
	}

	// 2. DisplayName via profile record (cosmetic — failure is fine)
	try {
		const res = await atprotoSession.handle(
			`/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=app.bsky.actor.profile&rkey=self`,
		);
		if (res.ok) {
			const data = (await res.json()) as {
				value?: { displayName?: string };
			};
			displayName = data.value?.displayName || null;
		}
	} catch (error) {
		console.warn("[atproto-auth] Failed to resolve profile record:", error);
	}

	return { displayName, handle };
}
