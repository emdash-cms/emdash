import { P256PublicKey, parsePublicMultikey } from "@atcute/crypto";
import { type Did, isDid } from "@atcute/lexicons/syntax";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const EXPIRED_AT = "1970-01-01T00:00:00.000Z";

export interface CachedLabelerIdentity {
	endpoint: string;
	signingKey: string;
	signingKeyId: string;
	resolvedAt: Date;
}

export interface LabelerIdentityCache {
	read(did: string): Promise<CachedLabelerIdentity | null>;
	refresh(
		did: string,
		identity: Omit<CachedLabelerIdentity, "resolvedAt">,
		now: Date,
	): Promise<void>;
	expire(did: string): Promise<void>;
}

export interface LabelerDidResolverLike {
	resolve(did: Did): Promise<unknown>;
}

export interface LabelerResolverOptions {
	cache: LabelerIdentityCache;
	resolver: LabelerDidResolverLike;
	ttlMs?: number;
	now?: () => Date;
}

export interface ResolvedLabelerIdentity {
	endpoint: string;
	publicKey: P256PublicKey;
	signingKeyId: string;
}

export class LabelerResolver {
	private readonly cache: LabelerIdentityCache;
	private readonly resolver: LabelerDidResolverLike;
	private readonly ttlMs: number;
	private readonly now: () => Date;

	constructor(options: LabelerResolverOptions) {
		this.cache = options.cache;
		this.resolver = options.resolver;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.now = options.now ?? (() => new Date());
	}

	async resolve(did: string): Promise<ResolvedLabelerIdentity> {
		return this.resolveConfigured(asDid(did), false);
	}

	/** Bypasses a fresh cache entry for W4.2's single retry after signature failure. */
	async resolveFresh(did: string): Promise<ResolvedLabelerIdentity> {
		return this.resolveConfigured(asDid(did), true);
	}

	/** Expires only resolver freshness; cached identity and operator config remain intact. */
	async invalidate(did: string): Promise<void> {
		await this.cache.expire(asDid(did));
	}

	private async resolveConfigured(did: Did, forceFresh: boolean): Promise<ResolvedLabelerIdentity> {
		const cached = await this.cache.read(did);
		if (!cached) throw new Error(`labeler is not configured: ${did}`);

		const now = this.now();
		if (!forceFresh && now.getTime() - cached.resolvedAt.getTime() < this.ttlMs) {
			return await materialise(cached, did);
		}

		const document = await this.resolver.resolve(did);
		const fresh = await extractIdentity(document, did);
		await this.cache.refresh(did, fresh, now);
		return await materialise({ ...fresh, resolvedAt: now }, did);
	}
}

function asDid(value: string): Did {
	if (!isDid(value)) throw new Error(`invalid DID: ${value}`);
	return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeId(did: string, id: string): string {
	return id.startsWith("#") ? `${did}${id}` : id;
}

async function extractIdentity(
	document: unknown,
	did: string,
): Promise<Omit<CachedLabelerIdentity, "resolvedAt">> {
	if (!isObject(document)) throw new TypeError("DID document must be an object");
	if (typeof document.id !== "string" || !isDid(document.id)) {
		throw new TypeError("DID document id must be a DID");
	}
	if (document.id !== did) throw new TypeError("DID document id does not match labeler DID");

	const service = findLogicalEntry(
		document.service,
		did,
		`${did}#atproto_labeler`,
		"service",
		"#atproto_labeler",
	);
	if (service.type !== "AtprotoLabeler") {
		throw new TypeError("#atproto_labeler service must have type AtprotoLabeler");
	}
	const endpoint = validateEndpoint(service.serviceEndpoint);

	const method = findLogicalEntry(
		document.verificationMethod,
		did,
		`${did}#atproto_label`,
		"verification method",
		"#atproto_label",
	);
	if (method.type !== "Multikey") {
		throw new TypeError("#atproto_label verification method must have type Multikey");
	}
	if (method.controller !== did) {
		throw new TypeError("#atproto_label verification method controller must equal the labeler DID");
	}
	if (typeof method.publicKeyMultibase !== "string") {
		throw new TypeError("#atproto_label verification method has an invalid Multikey");
	}
	await importCanonicalP256(method.publicKeyMultibase);

	return {
		endpoint,
		signingKey: method.publicKeyMultibase,
		signingKeyId: `${did}#atproto_label`,
	};
}

function findLogicalEntry(
	value: unknown,
	did: string,
	targetId: string,
	kind: string,
	fragment: string,
): Record<string, unknown> {
	if (!Array.isArray(value))
		throw new TypeError(`DID document must contain exactly one ${fragment} ${kind}`);
	const matches: Record<string, unknown>[] = [];
	for (const entry of value) {
		if (!isObject(entry) || typeof entry.id !== "string") {
			throw new TypeError(`DID document contains a malformed ${kind}`);
		}
		if (normalizeId(did, entry.id) === targetId) matches.push(entry);
	}
	if (matches.length !== 1) {
		throw new TypeError(`DID document must contain exactly one logical ${fragment} ${kind}`);
	}
	return matches[0]!;
}

function validateEndpoint(value: unknown): string {
	if (typeof value !== "string") {
		throw new TypeError("#atproto_labeler service endpoint must be an HTTPS URL");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("#atproto_labeler service endpoint must be an HTTPS URL");
	}
	if (url.protocol !== "https:") {
		throw new TypeError("#atproto_labeler service endpoint must use HTTPS");
	}
	if (url.username || url.password) {
		throw new TypeError("#atproto_labeler service endpoint must not contain credentials");
	}
	if (url.hash || value.includes("#"))
		throw new TypeError("#atproto_labeler service endpoint must not contain a fragment");
	return value;
}

async function importCanonicalP256(multikey: string): Promise<P256PublicKey> {
	let parsed: ReturnType<typeof parsePublicMultikey>;
	try {
		parsed = parsePublicMultikey(multikey);
	} catch {
		throw new TypeError("#atproto_label verification method has an invalid Multikey");
	}
	if (parsed.type !== "p256") {
		throw new TypeError("#atproto_label verification method must contain a P-256 Multikey");
	}
	if (
		parsed.publicKeyBytes.length !== 33 ||
		(parsed.publicKeyBytes[0] !== 0x02 && parsed.publicKeyBytes[0] !== 0x03)
	) {
		throw new TypeError("#atproto_label verification method must use a canonical P-256 Multikey");
	}
	let publicKey: P256PublicKey;
	try {
		publicKey = await P256PublicKey.importRaw(parsed.publicKeyBytes);
	} catch {
		throw new TypeError("#atproto_label verification method has an invalid P-256 Multikey");
	}
	if ((await publicKey.exportPublicKey("multikey")) !== multikey) {
		throw new TypeError("#atproto_label verification method must use a canonical P-256 Multikey");
	}
	return publicKey;
}

async function materialise(
	cached: CachedLabelerIdentity,
	did: string,
): Promise<ResolvedLabelerIdentity> {
	validateEndpoint(cached.endpoint);
	if (cached.signingKeyId !== `${did}#atproto_label`) {
		throw new TypeError("cached labeler signing key id is not canonical");
	}
	return {
		endpoint: cached.endpoint,
		publicKey: await importCanonicalP256(cached.signingKey),
		signingKeyId: cached.signingKeyId,
	};
}

export function createD1LabelerIdentityCache(db: D1Database): LabelerIdentityCache {
	return {
		async read(did): Promise<CachedLabelerIdentity | null> {
			const row = await db
				.prepare(
					`SELECT endpoint, signing_key, signing_key_id, last_resolved_at
					 FROM labelers
					 WHERE did = ?`,
				)
				.bind(did)
				.first<{
					endpoint: string;
					signing_key: string;
					signing_key_id: string;
					last_resolved_at: string;
				}>();
			if (!row) return null;
			return {
				endpoint: row.endpoint,
				signingKey: row.signing_key,
				signingKeyId: row.signing_key_id,
				resolvedAt: new Date(row.last_resolved_at),
			};
		},

		async refresh(did, identity, now): Promise<void> {
			const result = await db
				.prepare(
					`UPDATE labelers
					 SET endpoint = ?, signing_key = ?, signing_key_id = ?, last_resolved_at = ?
					 WHERE did = ?`,
				)
				.bind(identity.endpoint, identity.signingKey, identity.signingKeyId, now.toISOString(), did)
				.run();
			if (result.meta.changes !== 1) throw new Error(`labeler is not configured: ${did}`);
		},

		async expire(did): Promise<void> {
			await db
				.prepare("UPDATE labelers SET last_resolved_at = ? WHERE did = ?")
				.bind(EXPIRED_AT, did)
				.run();
		},
	};
}
