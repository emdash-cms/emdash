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
import { type DnsResolver, resolveAndValidateExternalUrl, SsrfError } from "emdash/security/ssrf";

const DEFAULT_TIMEOUT_MS = 15_000;
/** 5 MB ceiling. Records and their proofs are tiny (sub-KB typical); this is
 * a defence against a hostile or broken PDS streaming an unbounded body. */
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Redirect hops we'll follow before giving up. The PDS endpoint is
 * publisher-controlled, so redirects are an SSRF pivot: every hop is
 * re-validated, and this caps the chain. */
const MAX_PDS_REDIRECTS = 3;

export type VerificationFailureReason =
	| "PDS_NETWORK_ERROR"
	| "PDS_HTTP_ERROR"
	| "RECORD_NOT_FOUND"
	| "RESPONSE_TOO_LARGE"
	| "INVALID_PROOF"
	| "PDS_ADDRESS_BLOCKED";

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
	/** Default 15s wall-clock budget covering every redirect hop AND the body
	 * read — a slow-drip body is bounded by this, not just the initial fetch. */
	timeoutMs?: number;
	/** Default 5 MB. Rejects with `RESPONSE_TOO_LARGE` if exceeded. */
	maxResponseBytes?: number;
	/** Inject for tests; defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/**
	 * SSRF-safe hostname resolver applied to the PDS endpoint and every redirect
	 * target before we connect. Production injects `cloudflareDohResolver`; tests
	 * stub it. Absent means fail closed — the publisher-controlled fetch is
	 * refused rather than issued unprotected.
	 */
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

	// Fail closed: without a resolver we can't validate the publisher-controlled
	// endpoint against the SSRF blocklist, so we refuse rather than fetch blind.
	const resolveHostname = opts.resolveHostname;
	if (!resolveHostname) {
		throw new PdsVerificationError(
			"PDS_ADDRESS_BLOCKED",
			"refusing PDS fetch: no SSRF-safe hostname resolver was provided",
		);
	}

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

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Reject the URL unless it's HTTPS and resolves to a public address. The PDS
 * endpoint (and every redirect target) is publisher-controlled, so this is the
 * SSRF boundary: HTTP is refused (no plaintext downgrade to an internal
 * listener the resolver can't see), and `resolveAndValidateExternalUrl` resolves
 * the hostname and rejects any private/reserved address. IP/address logic lives
 * in the shared helper — never duplicated here.
 */
async function assertFetchableUrl(url: string, resolver: DnsResolver): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new PdsVerificationError("PDS_ADDRESS_BLOCKED", `invalid PDS URL: ${url}`);
	}
	if (parsed.protocol !== "https:") {
		throw new PdsVerificationError("PDS_ADDRESS_BLOCKED", `PDS URL must be https: ${url}`);
	}
	try {
		await resolveAndValidateExternalUrl(url, { resolver });
	} catch (err) {
		if (err instanceof SsrfError) {
			throw new PdsVerificationError(
				"PDS_ADDRESS_BLOCKED",
				`PDS address rejected: ${err.message}`,
				undefined,
				err,
			);
		}
		throw err;
	}
}

async function fetchCar(
	fetchImpl: typeof fetch,
	initialUrl: string,
	timeoutMs: number,
	maxBytes: number,
	resolver: DnsResolver,
): Promise<Uint8Array> {
	// One wall-clock budget spanning every redirect hop and the body read, so a
	// PDS that dribbles headers-then-body can't hold the request open past it.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let currentUrl = initialUrl;
		for (let hop = 0; ; hop++) {
			// Re-resolve and re-validate every hop: an allowed public host can
			// 30x to a private one, so validating only the initial URL is a hole.
			await assertFetchableUrl(currentUrl, resolver);

			let response: Response;
			try {
				response = await fetchImpl(currentUrl, {
					signal: controller.signal,
					// Intercept redirects so each target is re-validated before we
					// follow it, rather than letting fetch chase them unchecked.
					redirect: "manual",
					headers: { accept: "application/vnd.ipld.car" },
				});
			} catch (err) {
				// Whether the fetch threw because we aborted (timeout) or because
				// the network failed at the OS layer, the right caller behaviour
				// is the same: retry. Lump them under PDS_NETWORK_ERROR.
				throw new PdsVerificationError(
					"PDS_NETWORK_ERROR",
					err instanceof Error && err.name === "AbortError"
						? `PDS fetch aborted after ${timeoutMs}ms`
						: `PDS fetch failed: ${err instanceof Error ? err.message : String(err)}`,
					undefined,
					err,
				);
			}

			if (isRedirectStatus(response.status)) {
				// Free the redirect response's socket before following.
				await response.body?.cancel().catch(() => {});
				if (hop >= MAX_PDS_REDIRECTS) {
					throw new PdsVerificationError(
						"PDS_ADDRESS_BLOCKED",
						`PDS exceeded ${MAX_PDS_REDIRECTS} redirects`,
					);
				}
				const location = response.headers.get("location");
				if (!location) {
					throw new PdsVerificationError(
						"PDS_HTTP_ERROR",
						`PDS redirect without a Location header`,
						response.status,
					);
				}
				// The publisher fully controls this header; a malformed value
				// (e.g. `http://` with an empty authority) makes `new URL` throw a
				// raw TypeError. Classify it as a blocked redirect rather than
				// letting it escape as an UNEXPECTED_ERROR the publisher can force.
				try {
					currentUrl = new URL(location, currentUrl).toString();
				} catch {
					throw new PdsVerificationError(
						"PDS_ADDRESS_BLOCKED",
						`PDS redirect Location is not a valid URL: ${location}`,
					);
				}
				continue;
			}

			if (response.status === 404) {
				// Distinct from a generic 4xx. The publisher may have deleted the
				// record between Jetstream emitting and us fetching, which is the
				// common cause; other 4xx (auth, bad request) suggest programming
				// errors. Both end up dead-lettered by the consumer (the audit
				// trail is useful even for legitimate races so operators can spot
				// systematic Jetstream-vs-PDS skew); the distinct reason code keeps
				// them queryable separately.
				throw new PdsVerificationError(
					"RECORD_NOT_FOUND",
					`PDS returned 404 for ${currentUrl}`,
					404,
				);
			}
			if (!response.ok) {
				throw new PdsVerificationError(
					"PDS_HTTP_ERROR",
					`PDS returned ${response.status} for ${currentUrl}`,
					response.status,
				);
			}

			return await readCarBody(response, maxBytes, timeoutMs);
		}
	} finally {
		clearTimeout(timer);
	}
}

async function readCarBody(
	response: Response,
	maxBytes: number,
	timeoutMs: number,
): Promise<Uint8Array> {
	// Buffer the body up to the size limit. Don't trust Content-Length; a
	// hostile or buggy PDS could under-report and stream more bytes than
	// advertised.
	const reader = response.body?.getReader();
	if (!reader) {
		throw new PdsVerificationError("INVALID_PROOF", "PDS response body is null");
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
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
		// Our own errors (too-large) carry their classification; pass them
		// through. Anything else — a dropped socket, or the wall-clock deadline
		// aborting a slow-drip body mid-download — is transient: retry.
		if (err instanceof PdsVerificationError) throw err;
		throw new PdsVerificationError(
			"PDS_NETWORK_ERROR",
			err instanceof Error && err.name === "AbortError"
				? `PDS body read aborted after ${timeoutMs}ms`
				: `PDS stream failed mid-download: ${err instanceof Error ? err.message : String(err)}`,
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
