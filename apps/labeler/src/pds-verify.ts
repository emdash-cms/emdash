/**
 * Fetch + verify a single record from a publisher's PDS.
 *
 * Two-stage pipeline:
 *
 *   1. Fetch CAR bytes via `com.atproto.sync.getRecord` against the publisher's
 *      PDS endpoint (resolved upstream by `DidResolver`).
 *   2. Hand the bytes to `@atcute/repo`'s `verifyRecord`, which does MST
 *      inclusion proof + commit signature verification in one call against the
 *      publisher's `#atproto` signing key.
 *
 * Failures are reported via a structured `PdsVerificationError` carrying a
 * `reason` code. The consumer decides retry vs. forensics-and-ack based on the
 * code (network/5xx → retry; 404, response too large, invalid proof →
 * forensics + ack). Doing the classification here keeps the consumer's catch
 * block readable and lets future call sites (backfill, reconciliation) reuse
 * the same semantics.
 */

import type { PublicKey } from "@atcute/crypto";
import { type AtprotoDid, isDid } from "@atcute/lexicons/syntax";
import { verifyRecord } from "@atcute/repo";
import {
	cloudflareDohResolver,
	type DnsResolver,
	resolveAndValidateExternalUrl,
	SsrfError,
} from "emdash/security/ssrf";

const DEFAULT_TIMEOUT_MS = 15_000;
/** 5 MB ceiling. Records and their proofs are tiny (sub-KB typical); this is
 * a defence against a hostile or broken PDS streaming an unbounded body. */
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Redirect hops we'll follow before giving up. Each hop is independently
 * re-validated against the SSRF egress rules before it is fetched. */
const MAX_PDS_REDIRECTS = 3;

export type VerificationFailureReason =
	| "PDS_NETWORK_ERROR"
	| "PDS_HTTP_ERROR"
	| "RECORD_NOT_FOUND"
	| "RESPONSE_TOO_LARGE"
	| "INVALID_PROOF"
	| "PDS_HOST_BLOCKED";

export class PdsVerificationError extends Error {
	override readonly name = "PdsVerificationError";
	constructor(
		readonly reason: VerificationFailureReason,
		message: string,
		readonly status?: number,
		override readonly cause?: unknown,
	) {
		super(message);
	}
}

export interface FetchAndVerifyOptions {
	pds: string;
	did: string;
	collection: string;
	rkey: string;
	publicKey: PublicKey;
	/** Default 15s. Aborts the fetch if the PDS is slow. */
	timeoutMs?: number;
	/** Default 5 MB. Rejects with `RESPONSE_TOO_LARGE` if exceeded. */
	maxResponseBytes?: number;
	/** Inject for tests; defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/** Resolves each hop's hostname so its addresses can be checked against the
	 * private/reserved-IP blocklist before the request is made. Inject for
	 * tests; defaults to the DoH resolver used by artifact acquisition. */
	resolveHostname?: DnsResolver;
}

export interface VerifiedPdsRecord {
	cid: string;
	record: unknown;
	/** Raw CAR bytes the PDS served. Stored verbatim in `*.record_blob` so the
	 * read API can passthrough the signed envelope to clients without re-fetching. */
	carBytes: Uint8Array;
}

export async function fetchAndVerifyRecord(
	opts: FetchAndVerifyOptions,
): Promise<VerifiedPdsRecord> {
	const fetchImpl = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const resolveHostname = opts.resolveHostname ?? cloudflareDohResolver;

	if (!isAtprotoDid(opts.did)) {
		// Caller is expected to have validated this upstream (the resolver
		// rejects non-DID strings before reaching here), but the verifier's
		// type contract is narrower than `string` so guard explicitly.
		throw new PdsVerificationError(
			"INVALID_PROOF",
			`unsupported DID method (expected did:plc or did:web): ${opts.did}`,
		);
	}
	const url = buildGetRecordUrl(opts.pds, opts.did, opts.collection, opts.rkey);
	const carBytes = await fetchCar(fetchImpl, url, timeoutMs, maxResponseBytes, resolveHostname);

	try {
		const result = await verifyRecord({
			did: opts.did,
			collection: opts.collection,
			rkey: opts.rkey,
			publicKey: opts.publicKey,
			carBytes,
		});
		return { cid: result.cid, record: result.record, carBytes };
	} catch (err) {
		// `verifyRecord` rejects on signature failure, MST proof failure,
		// malformed CAR, or rkey/collection mismatch. All four are "drop and
		// log" outcomes — distinguishing them isn't load-bearing here, the
		// detail goes into the dead_letters detail column for forensics.
		throw new PdsVerificationError(
			"INVALID_PROOF",
			`verifyRecord failed: ${err instanceof Error ? err.message : String(err)}`,
			undefined,
			err,
		);
	}
}

function buildGetRecordUrl(pds: string, did: string, collection: string, rkey: string): string {
	const url = new URL("/xrpc/com.atproto.sync.getRecord", pds);
	url.searchParams.set("did", did);
	url.searchParams.set("collection", collection);
	url.searchParams.set("rkey", rkey);
	return url.toString();
}

/**
 * Reject a PDS URL that is not HTTPS or whose host resolves to a
 * private/reserved address. The publisher controls the PDS endpoint (and any
 * redirect it serves), so this reuses the same DNS-aware SSRF validator that
 * guards artifact acquisition rather than duplicating any address logic.
 */
async function assertAllowedPdsUrl(url: string, resolveHostname: DnsResolver): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new PdsVerificationError("PDS_HOST_BLOCKED", `PDS URL is not a valid URL: ${url}`);
	}
	if (parsed.protocol !== "https:") {
		throw new PdsVerificationError(
			"PDS_HOST_BLOCKED",
			`PDS URL must use https, got ${parsed.protocol}`,
		);
	}
	try {
		await resolveAndValidateExternalUrl(url, { resolver: resolveHostname });
	} catch (err) {
		if (err instanceof SsrfError) {
			throw new PdsVerificationError(
				"PDS_HOST_BLOCKED",
				`PDS host rejected: ${err.message}`,
				undefined,
				err,
			);
		}
		throw err;
	}
}

/**
 * Fetch `initialUrl`, following redirects manually so every hop — the
 * publisher-controlled PDS endpoint and any `Location` it names — is
 * re-validated against the SSRF egress rules before the request is made. A
 * hop pointing at a forbidden scheme or address rejects with
 * `PDS_HOST_BLOCKED`.
 */
async function fetchWithRedirectGuard(
	fetchImpl: typeof fetch,
	initialUrl: string,
	signal: AbortSignal,
	timeoutMs: number,
	resolveHostname: DnsResolver,
): Promise<Response> {
	let currentUrl = initialUrl;
	for (let hop = 0; ; hop++) {
		await assertAllowedPdsUrl(currentUrl, resolveHostname);

		let response: Response;
		try {
			response = await fetchImpl(currentUrl, {
				signal,
				redirect: "manual",
				headers: { accept: "application/vnd.ipld.car" },
			});
		} catch (err) {
			// Whether the fetch threw because we aborted (timeout) or because the
			// network failed at the OS layer, the right caller behaviour is the
			// same: retry. Lump them under PDS_NETWORK_ERROR.
			throw new PdsVerificationError(
				"PDS_NETWORK_ERROR",
				err instanceof Error && err.name === "AbortError"
					? `PDS fetch aborted after ${timeoutMs}ms`
					: `PDS fetch failed: ${err instanceof Error ? err.message : String(err)}`,
				undefined,
				err,
			);
		}

		if (response.status < 300 || response.status >= 400) return response;

		if (hop >= MAX_PDS_REDIRECTS) {
			throw new PdsVerificationError(
				"PDS_HTTP_ERROR",
				`PDS exceeded ${MAX_PDS_REDIRECTS} redirects`,
				response.status,
			);
		}
		const location = response.headers.get("location");
		if (location === null) {
			throw new PdsVerificationError(
				"PDS_HTTP_ERROR",
				`PDS redirect ${response.status} without a location header`,
				response.status,
			);
		}
		try {
			currentUrl = new URL(location, currentUrl).toString();
		} catch {
			throw new PdsVerificationError(
				"PDS_HOST_BLOCKED",
				`PDS redirect location is not a valid URL: ${location}`,
				response.status,
			);
		}
	}
}

async function fetchCar(
	fetchImpl: typeof fetch,
	url: string,
	timeoutMs: number,
	maxBytes: number,
	resolveHostname: DnsResolver,
): Promise<Uint8Array> {
	const deadline = Date.now() + timeoutMs;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let response: Response;
	try {
		response = await fetchWithRedirectGuard(
			fetchImpl,
			url,
			controller.signal,
			timeoutMs,
			resolveHostname,
		);
	} finally {
		clearTimeout(timer);
	}

	if (response.status === 404) {
		// Distinct from a generic 4xx. The publisher may have deleted the
		// record between Jetstream emitting and us fetching, which is the
		// common cause; other 4xx (auth, bad request) suggest programming
		// errors. Both end up dead-lettered by the consumer (the audit trail
		// is useful even for legitimate races so operators can spot
		// systematic Jetstream-vs-PDS skew); the distinct reason code keeps
		// them queryable separately.
		throw new PdsVerificationError("RECORD_NOT_FOUND", `PDS returned 404 for ${url}`, 404);
	}
	if (!response.ok) {
		throw new PdsVerificationError(
			"PDS_HTTP_ERROR",
			`PDS returned ${response.status} for ${url}`,
			response.status,
		);
	}

	// Buffer the body up to the size limit. Don't trust Content-Length; a
	// hostile or buggy PDS could under-report and stream more bytes than
	// advertised.
	const reader = response.body?.getReader();
	if (!reader) {
		throw new PdsVerificationError("INVALID_PROOF", "PDS response body is null");
	}
	return readCarBody(reader, maxBytes, deadline, timeoutMs);
}

/**
 * Buffer the CAR body, bounding both its size (`maxBytes`) and its total wall
 * time (`deadline`) — the header-phase abort timer is already cleared by the
 * time we stream, so without this a slow-drip PDS could hold the read open
 * indefinitely. Each read is raced against the remaining budget; exhausting it
 * rejects as a transient `PDS_NETWORK_ERROR` so the consumer retries.
 */
async function readCarBody(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	maxBytes: number,
	deadline: number,
	timeoutMs: number,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new PdsVerificationError(
					"PDS_NETWORK_ERROR",
					`PDS body read exceeded ${timeoutMs}ms`,
				);
			}
			const { done, value } = await readWithDeadline(reader, remaining, timeoutMs);
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				throw new PdsVerificationError(
					"RESPONSE_TOO_LARGE",
					`PDS response exceeded ${maxBytes} bytes`,
				);
			}
			chunks.push(value);
		}
	} catch (err) {
		// Cancel the stream so the underlying socket isn't left dangling.
		await reader.cancel().catch(() => {
			/* swallow — we already have a primary error to surface */
		});
		// A read error after headers (socket drop, stream abort, stall) is
		// transient — re-wrap it so the consumer retries rather than
		// dead-lettering it as an unexpected failure. Our own
		// PdsVerificationErrors (too-large, budget exceeded) carry their own
		// classification and pass through.
		if (err instanceof PdsVerificationError) throw err;
		throw new PdsVerificationError(
			"PDS_NETWORK_ERROR",
			`PDS stream failed mid-download: ${err instanceof Error ? err.message : String(err)}`,
			undefined,
			err,
		);
	} finally {
		reader.releaseLock();
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Race a single `reader.read()` against a per-read timeout. Handlers are
 * attached to the read promise so a read that loses the race cannot later
 * surface as an unhandled rejection.
 */
function readWithDeadline(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	remainingMs: number,
	timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(
				new PdsVerificationError("PDS_NETWORK_ERROR", `PDS body read exceeded ${timeoutMs}ms`),
			);
		}, remainingMs);
		void reader.read().then(
			(result) => {
				if (settled) return undefined;
				settled = true;
				clearTimeout(timer);
				resolve(result);
				return undefined;
			},
			(err: unknown) => {
				if (settled) return undefined;
				settled = true;
				clearTimeout(timer);
				reject(err);
				return undefined;
			},
		);
	});
}

/**
 * Map a `PdsVerificationError.reason` to "should the consumer retry?". Network
 * blips and 5xx are transient; everything else is permanent (forensics + ack).
 *
 * Exposed so the consumer can write `if (isTransient(err.reason, err.status))
 * message.retry()` without re-encoding the policy in the catch block.
 */
function isAtprotoDid(value: string): value is AtprotoDid {
	// Library `isDid` enforces the full grammar (length, terminator chars);
	// the prefix check then narrows to the atproto-supported method subset
	// (`did:plc:` or `did:web:`). A bare prefix check would accept things
	// like `did:plc:` (empty body), so the library call carries weight here.
	if (!isDid(value)) return false;
	return value.startsWith("did:plc:") || value.startsWith("did:web:");
}

export function isTransient(
	reason: VerificationFailureReason,
	status: number | undefined,
): boolean {
	if (reason === "PDS_NETWORK_ERROR") return true;
	if (reason === "PDS_HTTP_ERROR" && status !== undefined && status >= 500) return true;
	return false;
}
