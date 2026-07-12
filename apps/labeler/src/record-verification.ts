/**
 * Fetch + cryptographically verify the exact (uri, cid) a discovery event
 * named, per spec §9.1: "Jetstream is discovery only... a forged or
 * unverifiable event is retained as an operational dead letter and produces
 * no public label."
 *
 * Resolution wiring mirrors the aggregator's records-consumer
 * (`did-resolver.ts` + `CompositeDidDocumentResolver` over PLC and did:web):
 * resolve the publisher's DID document to learn their PDS endpoint and
 * `#atproto` signing key, then hand off to `fetchAndVerifyRecord` for the
 * MST-proof + signature check. Unlike the aggregator, there's no D1-backed
 * DID document cache here — discovery events are comparatively rare (one
 * per release, not one per read), so resolving fresh each time is simpler
 * and skips a cache-invalidation concern this PR doesn't need.
 */

import {
	getPublicKeyFromDidController,
	P256PublicKey,
	Secp256k1PublicKey,
	type PublicKey,
} from "@atcute/crypto";
import { type DidDocument, getAtprotoVerificationMaterial, getPdsEndpoint } from "@atcute/identity";
import { type Did, isDid } from "@atcute/lexicons/syntax";

import { fetchAndVerifyRecord, type VerifiedPdsRecord } from "./pds-verify.js";

export interface DidDocumentResolverLike {
	resolve(did: Did): Promise<DidDocument>;
}

export type RecordVerificationFailureReason =
	| "INVALID_URI"
	| "DID_RESOLUTION_FAILED"
	| "RECORD_CID_MISMATCH";

export class RecordVerificationError extends Error {
	override readonly name = "RecordVerificationError";
	constructor(
		readonly reason: RecordVerificationFailureReason,
		message: string,
		override readonly cause?: unknown,
	) {
		super(message);
	}
}

export interface ParsedReleaseUri {
	did: string;
	collection: string;
	rkey: string;
}

const AT_URI =
	/^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/([a-zA-Z][a-zA-Z0-9.]*)\/([A-Za-z0-9._~:%-]+)$/;

export function parseAtUri(uri: string): ParsedReleaseUri {
	const match = AT_URI.exec(uri);
	if (!match) throw new RecordVerificationError("INVALID_URI", `not a valid AT-URI: ${uri}`);
	const [, did, collection, rkey] = match;
	return { did: did!, collection: collection!, rkey: rkey! };
}

export interface FetchAndVerifyExactRecordOptions {
	uri: string;
	cid: string;
	didDocumentResolver: DidDocumentResolverLike;
	/** Inject for tests; defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
}

/**
 * Fetches and verifies the record at `uri`, then asserts the verified CID
 * matches `cid` exactly (decision: a mismatch means the PDS is serving a
 * newer version than the event named — that version's own event drives its
 * own assessment; this one is unobtainable and dead-letters).
 *
 * Throws `PdsVerificationError` for fetch/proof failures (the caller
 * classifies transient vs permanent via `isTransient`) and
 * `RecordVerificationError` for URI parsing, DID resolution, and CID-mismatch
 * failures — all of which are permanent (dead-letter, no retry).
 */
export async function fetchAndVerifyExactRecord(
	opts: FetchAndVerifyExactRecordOptions,
): Promise<VerifiedPdsRecord> {
	const { did, collection, rkey } = parseAtUri(opts.uri);
	if (!isDid(did)) throw new RecordVerificationError("INVALID_URI", `not a valid DID: ${did}`);

	let doc: DidDocument;
	try {
		doc = await opts.didDocumentResolver.resolve(did);
	} catch (err) {
		throw new RecordVerificationError(
			"DID_RESOLUTION_FAILED",
			`failed to resolve DID document for ${did}: ${err instanceof Error ? err.message : String(err)}`,
			err,
		);
	}
	const pds = getPdsEndpoint(doc);
	if (!pds) {
		throw new RecordVerificationError(
			"DID_RESOLUTION_FAILED",
			`DID document has no atproto PDS service entry: ${did}`,
		);
	}
	const material = getAtprotoVerificationMaterial(doc);
	if (!material) {
		throw new RecordVerificationError(
			"DID_RESOLUTION_FAILED",
			`DID document has no #atproto verification method: ${did}`,
		);
	}
	let publicKey: PublicKey;
	try {
		publicKey = await materialiseSigningKey(material.publicKeyMultibase);
	} catch (err) {
		throw new RecordVerificationError(
			"DID_RESOLUTION_FAILED",
			`unsupported atproto signing key for ${did}: ${err instanceof Error ? err.message : String(err)}`,
			err,
		);
	}

	// Propagates PdsVerificationError untouched — the consumer classifies
	// transient vs permanent via `isTransient`.
	const verified = await fetchAndVerifyRecord({
		pds,
		did,
		collection,
		rkey,
		publicKey,
		...(opts.fetch ? { fetch: opts.fetch } : {}),
		...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
	});

	if (verified.cid !== opts.cid) {
		throw new RecordVerificationError(
			"RECORD_CID_MISMATCH",
			`PDS served CID ${verified.cid} for ${opts.uri}, expected ${opts.cid}`,
		);
	}
	return verified;
}

async function materialiseSigningKey(publicKeyMultibase: string): Promise<PublicKey> {
	const found = getPublicKeyFromDidController({
		type: "Multikey",
		publicKeyMultibase,
	});
	if (found.type === "p256") return P256PublicKey.importRaw(found.publicKeyBytes);
	if (found.type === "secp256k1") return Secp256k1PublicKey.importRaw(found.publicKeyBytes);
	// Exhaustiveness check — `FoundPublicKey` is a discriminated union of
	// p256 and secp256k1 only. A new variant in a future @atcute/crypto
	// release should be handled explicitly.
	const exhaustive: never = found;
	throw new Error(`unsupported atproto signing key type: ${JSON.stringify(exhaustive)}`);
}
