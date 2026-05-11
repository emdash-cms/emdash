/**
 * DID document resolver with a TTL'd cache backed by `known_publishers`.
 *
 * The records consumer calls `resolve(did)` once per verification job to learn
 * the publisher's PDS endpoint and `#atproto` signing key. The signing key is
 * returned as a `PublicKey` instance (from `@atcute/crypto`) ready to hand to
 * `verifyRecord` in `@atcute/repo`.
 *
 * Pure constructor injection — no D1 imports in the class itself, so tests
 * pass an in-memory cache and a stub resolver. `createD1DidDocCache(db)` is
 * the production binding to `known_publishers`.
 */

import {
	getPublicKeyFromDidController,
	P256PublicKey,
	Secp256k1PublicKey,
	type PublicKey,
} from "@atcute/crypto";
import { type DidDocument, getAtprotoVerificationMaterial, getPdsEndpoint } from "@atcute/identity";
import { type Did, isDid } from "@atcute/lexicons/syntax";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Cache entry shape; the multibase signing key is stored raw so the
 * `PublicKey` instance is reconstructed on each `resolve()`. WebCrypto
 * `importKey` is fast enough that an in-memory `PublicKey` cache isn't worth
 * the complexity. */
export interface CachedDidDoc {
	pds: string;
	signingKey: string; // multibase
	signingKeyId: string; // e.g. 'did:plc:xxx#atproto'
	resolvedAt: Date;
}

export interface DidDocCache {
	read(did: string): Promise<CachedDidDoc | null>;
	upsert(did: string, doc: Omit<CachedDidDoc, "resolvedAt">, now: Date): Promise<void>;
	/** Force the cached row to look stale without disturbing other timestamps
	 * the cache tracks (e.g. `last_seen_at` in the D1 binding). Used by
	 * `DidResolver.invalidate()` after a signature failure suggests a key
	 * rotation. The implementation chooses what "stale" means; the
	 * Map-backed test cache rewrites `resolvedAt` to epoch, the D1 binding
	 * sets `pds_resolved_at` only. */
	expire(did: string): Promise<void>;
}

export interface DidDocumentResolverLike {
	resolve(did: Did): Promise<DidDocument>;
}

export interface DidResolverOptions {
	cache: DidDocCache;
	resolver: DidDocumentResolverLike;
	/** Default 24 hours. Cache entries older than this are re-resolved. */
	ttlMs?: number;
	/** Injected for deterministic tests. Defaults to `() => new Date()`. */
	now?: () => Date;
}

export interface ResolvedDidDoc {
	pds: string;
	publicKey: PublicKey;
	signingKeyId: string;
}

export class DidResolver {
	private readonly cache: DidDocCache;
	private readonly resolver: DidDocumentResolverLike;
	private readonly ttlMs: number;
	private readonly now: () => Date;

	constructor(opts: DidResolverOptions) {
		this.cache = opts.cache;
		this.resolver = opts.resolver;
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.now = opts.now ?? (() => new Date());
	}

	async resolve(did: string): Promise<ResolvedDidDoc> {
		const did_ = asDid(did);
		const now = this.now();
		const cached = await this.cache.read(did_);
		if (cached && now.getTime() - cached.resolvedAt.getTime() < this.ttlMs) {
			return materialise(cached);
		}
		const doc = await this.resolver.resolve(did_);
		const fresh = extractCacheable(doc);
		await this.cache.upsert(did_, fresh, now);
		return materialise({ ...fresh, resolvedAt: now });
	}

	/** Force a re-resolution next time. Used by the verification path on
	 * signature failure (the cached signing key may be stale after a
	 * publisher key rotation). Delegates to the cache's `expire` so other
	 * timestamps the cache tracks (e.g. `last_seen_at`) aren't disturbed —
	 * we shouldn't pretend the publisher hasn't been seen since 1970 just
	 * because we want to drop the cached crypto. */
	async invalidate(did: string): Promise<void> {
		await this.cache.expire(asDid(did));
	}
}

function asDid(did: string): Did {
	if (!isDid(did)) {
		throw new Error(`invalid DID: ${did}`);
	}
	return did;
}

function extractCacheable(doc: DidDocument): Omit<CachedDidDoc, "resolvedAt"> {
	const pds = getPdsEndpoint(doc);
	if (!pds) {
		throw new Error(`DID document has no atproto PDS service entry: ${doc.id}`);
	}
	const material = getAtprotoVerificationMaterial(doc);
	if (!material) {
		throw new Error(`DID document has no #atproto verification method: ${doc.id}`);
	}
	return {
		pds,
		signingKey: material.publicKeyMultibase,
		// Verification method ids are returned by `getAtprotoVerificationMaterial`
		// only as part of the wider doc; reconstruct the canonical id from the
		// DID + the well-known fragment.
		signingKeyId: `${doc.id}#atproto`,
	};
}

async function materialise(cached: CachedDidDoc): Promise<ResolvedDidDoc> {
	// `getPublicKeyFromDidController` only inspects `publicKeyMultibase`; the
	// `type` field is ignored by the parser (the multibase prefix carries the
	// curve). Pass a placeholder type — using the actual cached value would
	// require persisting it in `known_publishers` for no benefit.
	const found = getPublicKeyFromDidController({
		type: "Multikey",
		publicKeyMultibase: cached.signingKey,
	});
	let publicKey: PublicKey;
	if (found.type === "p256") {
		publicKey = await P256PublicKey.importRaw(found.publicKeyBytes);
	} else if (found.type === "secp256k1") {
		publicKey = await Secp256k1PublicKey.importRaw(found.publicKeyBytes);
	} else {
		// Exhaustiveness check — `FoundPublicKey` is a discriminated union of
		// p256 and secp256k1 only. A new variant in a future @atcute/crypto
		// release should be handled explicitly.
		const _exhaustive: never = found;
		throw new Error(`unsupported atproto signing key type`);
	}
	return {
		pds: cached.pds,
		publicKey,
		signingKeyId: cached.signingKeyId,
	};
}

/**
 * D1-backed cache binding `known_publishers`. Used in production; tests pass
 * an in-memory `Map`-backed `DidDocCache` instead.
 *
 * `first_seen_at` is set on the first insert and preserved on update. Tests
 * confirm this — the consumer needs the discovery timestamp to be sticky for
 * reconciliation reporting later.
 */
export function createD1DidDocCache(db: D1Database): DidDocCache {
	return {
		async read(did: string): Promise<CachedDidDoc | null> {
			const row = await db
				.prepare(
					`SELECT pds, signing_key, signing_key_id, pds_resolved_at
					 FROM known_publishers
					 WHERE did = ?`,
				)
				.bind(did)
				.first<{
					pds: string | null;
					signing_key: string | null;
					signing_key_id: string | null;
					pds_resolved_at: string | null;
				}>();
			if (
				!row ||
				row.pds === null ||
				row.signing_key === null ||
				row.signing_key_id === null ||
				row.pds_resolved_at === null
			) {
				return null;
			}
			return {
				pds: row.pds,
				signingKey: row.signing_key,
				signingKeyId: row.signing_key_id,
				resolvedAt: new Date(row.pds_resolved_at),
			};
		},
		async upsert(did, doc, now): Promise<void> {
			const nowIso = now.toISOString();
			await db
				.prepare(
					`INSERT INTO known_publishers
					   (did, pds, signing_key, signing_key_id, pds_resolved_at, first_seen_at, last_seen_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(did) DO UPDATE SET
					   pds = excluded.pds,
					   signing_key = excluded.signing_key,
					   signing_key_id = excluded.signing_key_id,
					   pds_resolved_at = excluded.pds_resolved_at,
					   last_seen_at = excluded.last_seen_at`,
				)
				.bind(did, doc.pds, doc.signingKey, doc.signingKeyId, nowIso, nowIso, nowIso)
				.run();
		},
		async expire(did): Promise<void> {
			// Touches only `pds_resolved_at`; first_seen_at / last_seen_at /
			// the cached crypto are intentionally untouched. Setting to epoch
			// is unambiguous "older than any plausible TTL". No-op when the
			// row doesn't exist.
			await db
				.prepare(
					`UPDATE known_publishers SET pds_resolved_at = '1970-01-01T00:00:00.000Z'
					 WHERE did = ?`,
				)
				.bind(did)
				.run();
		},
	};
}
