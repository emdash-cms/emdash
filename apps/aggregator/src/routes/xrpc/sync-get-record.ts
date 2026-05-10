/**
 * `com.atproto.sync.getRecord` — passthrough of stored CAR bytes.
 *
 * Slingshot-style behaviour: the aggregator is also a cached record store
 * for the four collections it indexes. Install-time clients fetch the
 * signed CAR from us instead of round-tripping to per-publisher PDSes —
 * faster install, resilient when a publisher's PDS is slow/down, lower
 * load on publisher PDSes.
 *
 * Trust model holds because clients re-verify the signature against the
 * publisher's signing key (resolved independently from the DID document).
 * The aggregator can serve stale or withhold but cannot forge.
 *
 * Implemented as a manual route rather than via @atcute/xrpc-server because
 * we don't have a generated lexicon binding for atproto's
 * `com.atproto.sync.getRecord` (it's atproto's, not ours), and the response
 * is `application/vnd.ipld.car` not JSON. Wiring it through the typed
 * router would mean authoring a stub lexicon for the sole purpose of
 * registration, which is more code than this module.
 */

import { isDid } from "@atcute/lexicons/syntax";
import { NSID } from "@emdash-cms/registry-lexicons";

const CAR_CONTENT_TYPE = "application/vnd.ipld.car";
/** 5 minutes. The CAR bytes are content-addressed (CID-derivable) so a
 * stale cache is detectable client-side; we trade absolute freshness for
 * lower aggregator load on the install-time hot path. Tighter than the
 * aggregator endpoints (`no-store`) because there's no label-dependent
 * filtering on this passthrough. */
const CACHE_CONTROL = "public, max-age=300";

interface ParsedQuery {
	did: string;
	collection: string;
	rkey: string;
}

export async function syncGetRecord(env: Env, request: Request): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return jsonError(405, "MethodNotAllowed", "method not allowed", { allow: "GET, HEAD" });
	}
	const parseResult = parseQuery(request);
	if ("error" in parseResult) return parseResult.error;
	const { did, collection, rkey } = parseResult;

	const carBytes = await fetchRecordBlob(env, did, collection, rkey);
	if (!carBytes) {
		return jsonError(
			404,
			"RecordNotFound",
			`record not found for (${did}, ${collection}, ${rkey})`,
		);
	}
	// Normalise to a Uint8Array view. D1 returns BLOBs as ArrayBuffer in
	// production but as Uint8Array via miniflare in tests; wrapping in
	// `new Uint8Array(buf)` produces the byte-stream shape workerd's
	// Response constructor wants. (Without this normalisation, passing an
	// `ArrayBuffer` directly works in production but trips miniflare's
	// "ReadableStream did not return bytes" check.)
	//
	// `new Uint8Array(arrayBuffer)` *views* the buffer rather than copying.
	// That's safe here because workerd buffers the entire body during
	// Response construction (the body isn't streamed asynchronously back
	// to the client over the lifetime of the underlying buffer).
	const body = carBytes instanceof Uint8Array ? carBytes : new Uint8Array(carBytes);
	return new Response(request.method === "HEAD" ? null : body, {
		status: 200,
		headers: {
			"content-type": CAR_CONTENT_TYPE,
			"content-length": String(body.byteLength),
			"cache-control": CACHE_CONTROL,
		},
	});
}

function parseQuery(request: Request): ParsedQuery | { error: Response } {
	const url = new URL(request.url);
	const did = url.searchParams.get("did");
	const collection = url.searchParams.get("collection");
	const rkey = url.searchParams.get("rkey");
	if (!did || !collection || !rkey) {
		return {
			error: jsonError(400, "InvalidRequest", "missing required param: did, collection, rkey"),
		};
	}
	if (!isDid(did)) {
		return { error: jsonError(400, "InvalidRequest", `invalid did: ${did}`) };
	}
	return { did, collection, rkey };
}

async function fetchRecordBlob(
	env: Env,
	did: string,
	collection: string,
	rkey: string,
): Promise<ArrayBuffer | Uint8Array | null> {
	// Cacheable read — `first-unconstrained` lets D1 hit the nearest
	// replica. The CAR bytes are immutable per record version (the writer
	// rejects content changes via CID-based dedup), so even a slightly stale
	// replica returns the same bytes a primary would.
	const session = env.DB.withSession("first-unconstrained");
	switch (collection) {
		case NSID.packageProfile:
			return selectBlob(session, `SELECT record_blob FROM packages WHERE did = ? AND slug = ?`, [
				did,
				rkey,
			]);
		case NSID.packageRelease:
			return selectBlob(
				session,
				`SELECT record_blob FROM releases WHERE did = ? AND rkey = ? AND tombstoned_at IS NULL`,
				[did, rkey],
			);
		case NSID.publisherProfile:
			// publisher.profile rkey is always 'self' per the writer's enforcement.
			if (rkey !== "self") return null;
			return selectBlob(session, `SELECT record_blob FROM publishers WHERE did = ?`, [did]);
		case NSID.publisherVerification:
			return selectBlob(
				session,
				`SELECT record_blob FROM publisher_verifications WHERE issuer_did = ? AND rkey = ? AND tombstoned_at IS NULL`,
				[did, rkey],
			);
		default:
			return null;
	}
}

async function selectBlob(
	session: D1DatabaseSession,
	sql: string,
	bindings: unknown[],
): Promise<ArrayBuffer | Uint8Array | null> {
	const row = await session
		.prepare(sql)
		.bind(...bindings)
		.first<{ record_blob: ArrayBuffer | Uint8Array }>();
	return row?.record_blob ?? null;
}

function jsonError(
	status: number,
	error: string,
	message: string,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify({ error, message }), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}
