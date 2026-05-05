/**
 * Resolves the publisher's atproto profile (display name, handle, PDS URL)
 * from a freshly-authenticated `OAuthSession`.
 *
 * The OAuth session itself only carries the DID. To show the publisher who
 * they're logged in as -- and to pin a stable PDS URL into the credentials
 * store -- we make two best-effort calls:
 *
 *   1. `com.atproto.server.getSession` for the authoritative current handle.
 *   2. `app.bsky.actor.profile` (rkey `self`) for the optional displayName.
 *
 * Either call may fail (network, optional profile record absent). We treat
 * both as best-effort and fall back to the DID for handle and `null` for
 * displayName, so login still completes for accounts that haven't created a
 * Bluesky-style profile.
 */

import type { OAuthSession } from "@atcute/oauth-node-client";

interface GetSessionResponse {
	handle?: string;
	pdsUrl?: string;
}

export interface AtprotoProfile {
	handle: string;
	displayName: string | null;
	pds: string;
}

export async function resolveAtprotoProfile(session: OAuthSession): Promise<AtprotoProfile> {
	const did = session.sub;

	let handle: string = did;
	let displayName: string | null = null;
	let pds = "";

	try {
		const res = await session.handle("/xrpc/com.atproto.server.getSession");
		if (res.ok) {
			const data = pickGetSession(await res.json());
			if (data.handle) handle = data.handle;
			if (data.pdsUrl) pds = data.pdsUrl;
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
	if ("pdsUrl" in input && typeof input.pdsUrl === "string") out.pdsUrl = input.pdsUrl;
	return out;
}

function pickDisplayName(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	if (!("value" in input) || !input.value || typeof input.value !== "object") return null;
	if (!("displayName" in input.value)) return null;
	return typeof input.value.displayName === "string" ? input.value.displayName : null;
}
