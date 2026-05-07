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
 *   2. Handle: resolved from the DID document via `LocalActorResolver`.
 *      `alsoKnownAs` is read off the DID doc and the handle is verified to
 *      round-trip back to the same DID before it's accepted. No PDS XRPC
 *      involved -- this works regardless of how the PDS handles OAuth/DPoP
 *      tokens, and doesn't need an `rpc:` scope. Falls back to the DID on
 *      failure; the caller detects that via `isHandle()`.
 *   3. Display name: `app.bsky.actor.profile` (rkey `self`) via
 *      `getRecord` -- a public repo read that doesn't require auth. Absent
 *      profile records are not an error.
 *
 * The PDS URL is no longer best-effort: a session without a usable PDS
 * is unrecoverable, so we throw rather than persist an empty string and
 * lock the user out of subsequent commands.
 */

import type { OAuthSession } from "@atcute/oauth-node-client";

import { createActorResolver } from "./oauth.js";

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
		const resolved = await createActorResolver().resolve(did);
		// `LocalActorResolver` returns `'handle.invalid'` when the
		// alsoKnownAs handle doesn't round-trip back to this DID. Treat
		// that as "no handle" and fall back to the DID.
		if (resolved.handle && resolved.handle !== "handle.invalid") {
			handle = resolved.handle;
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

function pickDisplayName(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	if (!("value" in input) || !input.value || typeof input.value !== "object") return null;
	if (!("displayName" in input.value)) return null;
	return typeof input.value.displayName === "string" ? input.value.displayName : null;
}
