/**
 * Resolves the publisher's atproto profile (display name, handle, PDS URL)
 * from a freshly-authenticated `OAuthSession`.
 *
 * Sources, in order of authority:
 *
 *   1. PDS URL: `session.getTokenInfo().aud`. The OAuth `aud` claim is the
 *      resource server URL the session is bound to -- exactly the PDS the
 *      session can actually talk to. Always populated for authenticated
 *      sessions; never empty.
 *   2. Handle: `com.atproto.server.getSession`. Best-effort; falls back
 *      to the DID on failure. The DID is then surfaced as a placeholder
 *      handle that the caller is expected to detect (`isHandle()`) and
 *      treat as null for storage.
 *   3. Display name: `app.bsky.actor.profile` (rkey `self`). Optional;
 *      absent profile records are not an error.
 *
 * The PDS URL is no longer best-effort: a session without a usable PDS
 * is unrecoverable, so we throw rather than persist an empty string and
 * lock the user out of subsequent commands.
 */

import type { OAuthSession } from "@atcute/oauth-node-client";

interface GetSessionResponse {
	handle?: string;
}

export interface AtprotoProfile {
	handle: string;
	displayName: string | null;
	pds: string;
}

export async function resolveAtprotoProfile(session: OAuthSession): Promise<AtprotoProfile> {
	const did = session.sub;

	// PDS URL: read directly from the OAuth token's `aud` claim. This is
	// the URL atcute itself uses for every authenticated request from the
	// session, so it's guaranteed populated. The previous implementation
	// tried `getSession.pdsUrl`, which doesn't exist in the Bluesky lexicon
	// -- the field is always undefined, leaving `pds` empty and corrupting
	// the credentials store on the next read.
	const tokenInfo = await session.getTokenInfo();
	const pds = tokenInfo.aud;
	if (typeof pds !== "string" || pds.length === 0) {
		// Defensive: should be impossible per atcute's session model, but if
		// it ever isn't, fail loudly here rather than persisting "" and
		// locking the user out.
		throw new Error(
			"OAuth session has no `aud` (PDS URL); cannot resolve publisher profile. This is a bug -- please report it.",
		);
	}

	let handle: string = did;
	let displayName: string | null = null;

	try {
		const res = await session.handle("/xrpc/com.atproto.server.getSession");
		if (res.ok) {
			const data = pickGetSession(await res.json());
			if (data.handle) handle = data.handle;
		}
	} catch {
		// best-effort; fall through to DID as handle
	}

	try {
		const res = await session.handle(
			`/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=app.bsky.actor.profile&rkey=self`,
		);
		if (res.ok) {
			displayName = pickDisplayName(await res.json());
		}
	} catch {
		// optional record; absence is fine
	}

	return { handle, displayName, pds };
}

function pickGetSession(input: unknown): GetSessionResponse {
	if (!input || typeof input !== "object") return {};
	const out: GetSessionResponse = {};
	if ("handle" in input && typeof input.handle === "string") out.handle = input.handle;
	return out;
}

function pickDisplayName(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	if (!("value" in input) || !input.value || typeof input.value !== "object") return null;
	if (!("displayName" in input.value)) return null;
	return typeof input.value.displayName === "string" ? input.value.displayName : null;
}
