/**
 * AT Protocol identity resolver with a TTL'd cache backed by `known_publishers`.
 *
 * Production resolution asks Slingshot for a bidirectionally verified MiniDoc,
 * then falls back to direct DID and handle resolution when Slingshot fails.
 * The signing key is returned as a `PublicKey` ready for `@atcute/repo`.
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
import {
	type DidDocument,
	getAtprotoHandle,
	getAtprotoVerificationMaterial,
	getPdsEndpoint,
} from "@atcute/identity";
import {
	AtprotoWebDidDocumentResolver,
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	PlcDidDocumentResolver,
	WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import { type Did, type Handle, isDid, isHandle } from "@atcute/lexicons/syntax";

import { boundFetch, isPlainObject } from "./utils.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDENTITY_TIMEOUT_MS = 5_000;
const MAX_IDENTITY_RESPONSE_BYTES = 20 * 1024;
const HANDLE_REFRESH_AGE_MS = 5 * 60 * 1000;
const HANDLE_REFRESH_BATCH_SIZE = 25;

/** Cache entry shape; the multibase signing key is stored raw so the
 * `PublicKey` instance is reconstructed on each `resolve()`. WebCrypto
 * `importKey` is fast enough that an in-memory `PublicKey` cache isn't worth
 * the complexity. */
export interface CachedDidDoc {
	handle?: string | null;
	pds: string;
	signingKey: string; // multibase
	signingKeyId: string; // e.g. 'did:plc:xxx#atproto'
	resolvedAt: Date;
}

export interface DidDocCache {
	read(did: string): Promise<CachedDidDoc | null>;
	readByHandle?(
		handle: Handle,
		resolvedAfter: Date,
	): Promise<{ did: Did; value: CachedDidDoc } | null>;
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

export interface HandleResolverLike {
	resolve(handle: Handle): Promise<Did>;
}

export interface ResolvedIdentityMiniDoc {
	did: Did;
	handle: Handle | null;
	pds: string;
	signingKey: string;
}

export interface IdentityResolverLike {
	resolve(identifier: string): Promise<ResolvedIdentityMiniDoc>;
}

export interface DidResolverOptions {
	cache: DidDocCache;
	resolver: DidDocumentResolverLike;
	identityResolver?: IdentityResolverLike;
	handleResolver?: HandleResolverLike;
	/** Default 24 hours. Cache entries older than this are re-resolved. */
	ttlMs?: number;
	/** Injected for deterministic tests. Defaults to `() => new Date()`. */
	now?: () => Date;
}

export interface ResolvedDidDoc {
	handle?: Handle;
	resolvedHandle?: Handle | null;
	identityCacheHit?: boolean;
	pds: string;
	publicKey: PublicKey;
	signingKeyId: string;
}

export class DidResolver {
	private readonly cache: DidDocCache;
	private readonly resolver: DidDocumentResolverLike;
	private readonly identityResolver: IdentityResolverLike | undefined;
	private readonly handleResolver: HandleResolverLike | undefined;
	private readonly ttlMs: number;
	private readonly now: () => Date;

	constructor(opts: DidResolverOptions) {
		this.cache = opts.cache;
		this.resolver = opts.resolver;
		this.identityResolver = opts.identityResolver;
		this.handleResolver = opts.handleResolver;
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
		const fresh = await this.resolveFreshDid(did_);
		const resolved = await materialise({ ...fresh, resolvedAt: now });
		await this.cache.upsert(did_, fresh, now);
		return resolved;
	}

	async resolveIdentifier(identifier: string): Promise<ResolvedDidDoc & { did: Did }> {
		const now = this.now();
		if (isHandle(identifier) && this.cache.readByHandle) {
			const cached = await this.cache.readByHandle(
				identifier,
				new Date(now.getTime() - HANDLE_REFRESH_AGE_MS),
			);
			if (cached) {
				return {
					did: cached.did,
					...(await materialise(cached.value)),
					identityCacheHit: true,
				};
			}
		}
		if (this.identityResolver) {
			try {
				const identity = await this.identityResolver.resolve(identifier);
				if (
					(isDid(identifier) && identity.did !== identifier) ||
					(isHandle(identifier) && identity.handle !== identifier)
				) {
					throw new Error(`identity resolver returned a different identity`);
				}
				const doc = await this.resolver.resolve(identity.did);
				const fresh = { ...extractCacheable(doc), handle: identity.handle };
				const resolved = await materialise({ ...fresh, resolvedAt: now });
				return { did: identity.did, ...resolved };
			} catch {
				// Fall through to direct atproto resolution.
			}
		}

		if (isDid(identifier)) {
			const doc = await this.resolver.resolve(identifier);
			const handle = await this.verifiedHandleFromDocument(doc, identifier);
			const resolved = await materialise({
				...extractCacheable(doc),
				handle,
				resolvedAt: now,
			});
			return { did: identifier, ...resolved };
		}
		if (!isHandle(identifier) || !this.handleResolver) {
			throw new Error(`invalid or unresolvable atproto identifier: ${identifier}`);
		}
		const did = await this.handleResolver.resolve(identifier);
		const doc = await this.resolver.resolve(did);
		if (getAtprotoHandle(doc) !== identifier) {
			throw new Error(`handle does not resolve bidirectionally: ${identifier}`);
		}
		const fresh = { ...extractCacheable(doc), handle: identifier };
		const resolved = await materialise({ ...fresh, resolvedAt: now });
		return { did, ...resolved };
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

	private async resolveFreshDid(did: Did): Promise<Omit<CachedDidDoc, "resolvedAt">> {
		const doc = await this.resolver.resolve(did);
		const authoritative = extractCacheable(doc);
		if (this.identityResolver) {
			try {
				const identity = await this.identityResolver.resolve(did);
				if (identity.did !== did) throw new Error(`identity resolver returned a different DID`);
				return { ...authoritative, handle: identity.handle };
			} catch {
				// Direct resolution remains authoritative when the cache service fails.
			}
		}
		return { ...authoritative, handle: await this.verifiedHandleFromDocument(doc, did) };
	}

	private async verifiedHandleFromDocument(
		doc: DidDocument,
		did: Did,
	): Promise<Handle | null | undefined> {
		const handle = getAtprotoHandle(doc);
		if (!handle) return null;
		if (!this.handleResolver) return undefined;
		try {
			return (await this.handleResolver.resolve(handle)) === did ? handle : null;
		} catch {
			return undefined;
		}
	}
}

export interface SlingshotIdentityResolverOptions {
	serviceUrl: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export class SlingshotIdentityResolver implements IdentityResolverLike {
	readonly serviceUrl: string;
	private readonly fetch: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: SlingshotIdentityResolverOptions) {
		const service = new URL(options.serviceUrl);
		if (service.protocol !== "https:" || service.username || service.password) {
			throw new TypeError("identity resolver URL must be an HTTPS service");
		}
		this.serviceUrl = service.href;
		this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS;
	}

	async resolve(identifier: string): Promise<ResolvedIdentityMiniDoc> {
		const url = new URL("/xrpc/blue.microcosm.identity.resolveMiniDoc", this.serviceUrl);
		url.searchParams.set("identifier", identifier);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let response: Response;
		try {
			response = await this.fetch(url, {
				headers: { accept: "application/json" },
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok) throw new Error(`identity resolver returned ${response.status}`);
		const value = await readBoundedJson(response, MAX_IDENTITY_RESPONSE_BYTES);
		if (
			!isPlainObject(value) ||
			!isDid(value["did"]) ||
			typeof value["handle"] !== "string" ||
			(value["handle"] !== "handle.invalid" && !isHandle(value["handle"])) ||
			typeof value["pds"] !== "string" ||
			typeof value["signing_key"] !== "string"
		) {
			throw new Error("identity resolver returned a malformed MiniDoc");
		}
		const pds = new URL(value["pds"]);
		if (pds.protocol !== "https:" || pds.username || pds.password) {
			throw new Error("identity resolver returned an invalid PDS URL");
		}
		return {
			did: value["did"],
			handle: value["handle"] === "handle.invalid" ? null : value["handle"],
			pds: pds.href,
			signingKey: value["signing_key"],
		};
	}
}

export function createProductionDidResolver(env: Env): DidResolver {
	return new DidResolver({
		cache: createD1DidDocCache(env.DB),
		identityResolver: new SlingshotIdentityResolver({
			serviceUrl: env.IDENTITY_RESOLVER_URL,
			fetch: boundFetch,
		}),
		handleResolver: new CompositeHandleResolver({
			strategy: "race",
			methods: {
				dns: new DohJsonHandleResolver({
					dohUrl: "https://mozilla.cloudflare-dns.com/dns-query",
					fetch: boundFetch,
				}),
				http: new WellKnownHandleResolver({ fetch: boundFetch }),
			},
		}),
		resolver: new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver({ fetch: boundFetch }),
				web: new AtprotoWebDidDocumentResolver({ fetch: boundFetch }),
			},
		}),
	});
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("identity resolver response body is missing");
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel("identity resolver response exceeded its byte limit");
			throw new Error("identity resolver response exceeded its byte limit");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
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
		...(typeof cached.handle === "string" && isHandle(cached.handle)
			? { handle: cached.handle }
			: {}),
		...(cached.handle !== undefined
			? {
					resolvedHandle:
						typeof cached.handle === "string" && isHandle(cached.handle) ? cached.handle : null,
				}
			: {}),
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
					`SELECT handle, pds, signing_key, signing_key_id, pds_resolved_at
					 FROM known_publishers
					 WHERE did = ?`,
				)
				.bind(did)
				.first<{
					handle: string | null;
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
				handle: row.handle,
				pds: row.pds,
				signingKey: row.signing_key,
				signingKeyId: row.signing_key_id,
				resolvedAt: new Date(row.pds_resolved_at),
			};
		},
		async readByHandle(handle, resolvedAfter) {
			const row = await db
				.prepare(
					`SELECT did, handle, pds, signing_key, signing_key_id, pds_resolved_at
					 FROM known_publishers
					 WHERE handle = ? AND handle_resolved_at >= ?`,
				)
				.bind(handle, resolvedAfter.toISOString())
				.first<{
					did: string;
					handle: string;
					pds: string | null;
					signing_key: string | null;
					signing_key_id: string | null;
					pds_resolved_at: string | null;
				}>();
			if (
				!row ||
				!isDid(row.did) ||
				row.pds === null ||
				row.signing_key === null ||
				row.signing_key_id === null ||
				row.pds_resolved_at === null
			) {
				return null;
			}
			return {
				did: row.did,
				value: {
					handle: row.handle,
					pds: row.pds,
					signingKey: row.signing_key,
					signingKeyId: row.signing_key_id,
					resolvedAt: new Date(row.pds_resolved_at),
				},
			};
		},
		async upsert(did, doc, now): Promise<void> {
			const nowIso = now.toISOString();
			const updateHandle = doc.handle !== undefined ? 1 : 0;
			const statements: D1PreparedStatement[] = [];
			if (typeof doc.handle === "string") {
				statements.push(
					db
						.prepare(
							`UPDATE known_publishers
							 SET handle = NULL, handle_resolved_at = NULL
							 WHERE handle = ? AND did <> ?`,
						)
						.bind(doc.handle, did),
				);
			}
			statements.push(
				db
					.prepare(
						`INSERT INTO known_publishers
					   (did, handle, handle_resolved_at, pds, signing_key, signing_key_id,
					    pds_resolved_at, first_seen_at, last_seen_at)
					 VALUES (?, ?, CASE WHEN ? = 1 THEN ? ELSE NULL END, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(did) DO UPDATE SET
					   handle = CASE WHEN ? = 1 THEN excluded.handle ELSE known_publishers.handle END,
					   handle_resolved_at = CASE WHEN ? = 1 THEN excluded.handle_resolved_at ELSE known_publishers.handle_resolved_at END,
					   pds = excluded.pds,
					   signing_key = excluded.signing_key,
					   signing_key_id = excluded.signing_key_id,
					   pds_resolved_at = excluded.pds_resolved_at,
					   last_seen_at = excluded.last_seen_at`,
					)
					.bind(
						did,
						doc.handle ?? null,
						updateHandle,
						nowIso,
						doc.pds,
						doc.signingKey,
						doc.signingKeyId,
						nowIso,
						nowIso,
						nowIso,
						updateHandle,
						updateHandle,
					),
			);
			await db.batch(statements);
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

export async function upsertPublisherHandle(
	db: D1Database,
	did: Did,
	handle: Handle | null,
	now = new Date(),
): Promise<void> {
	const nowIso = now.toISOString();
	const statements: D1PreparedStatement[] = [];
	if (handle !== null) {
		statements.push(
			db
				.prepare(
					`UPDATE known_publishers
				 SET handle = NULL, handle_resolved_at = NULL
				 WHERE handle = ? AND did <> ?`,
				)
				.bind(handle, did),
		);
	}
	statements.push(
		db
			.prepare(
				`INSERT INTO known_publishers
			   (did, handle, handle_resolved_at, first_seen_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(did) DO UPDATE SET
			   handle = excluded.handle,
			   handle_resolved_at = excluded.handle_resolved_at`,
			)
			.bind(did, handle, nowIso, nowIso, nowIso),
	);
	await db.batch(statements);
}

export async function refreshStalePublisherHandles(
	db: D1Database,
	resolver: DidResolver,
	options: { now?: Date; limit?: number } = {},
): Promise<{ refreshed: number; unresolved: number }> {
	const now = options.now ?? new Date();
	const limit = Math.min(Math.max(options.limit ?? HANDLE_REFRESH_BATCH_SIZE, 1), 100);
	const cutoff = new Date(now.getTime() - HANDLE_REFRESH_AGE_MS).toISOString();
	const rows = await db
		.prepare(
			`SELECT did
			 FROM known_publishers
			 WHERE handle_resolved_at IS NULL OR handle_resolved_at < ?
			 ORDER BY COALESCE(handle_refresh_attempted_at, handle_resolved_at, '') ASC, did ASC
			 LIMIT ?`,
		)
		.bind(cutoff, limit)
		.all<{ did: string }>();
	if (rows.results.length > 0) {
		const placeholders = rows.results.map(() => "?").join(", ");
		await db
			.prepare(
				`UPDATE known_publishers
				 SET handle_refresh_attempted_at = ?
				 WHERE did IN (${placeholders})`,
			)
			.bind(now.toISOString(), ...rows.results.map((row) => row.did))
			.run();
	}
	const results = await Promise.allSettled(
		rows.results.map((row) => resolver.resolveIdentifier(row.did)),
	);
	let refreshed = 0;
	for (const result of results) {
		if (result.status === "fulfilled" && result.value.resolvedHandle !== undefined) {
			await upsertPublisherHandle(db, result.value.did, result.value.resolvedHandle, now);
			refreshed++;
		}
	}
	return { refreshed, unresolved: results.length - refreshed };
}
