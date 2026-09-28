import { P256PublicKey, parsePublicMultikey } from "@atcute/crypto";
import { type Did, isDid } from "@atcute/lexicons/syntax";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const TRAILING_SLASH = /\/$/;

export interface ResolvedLabelerIdentity {
	endpoint: string;
	publicKey: P256PublicKey;
	signingKeyId: string;
	resolvedAtEpochMs: number;
	expiresAtEpochMs: number;
}

export interface ResolvedLabelVerificationKey {
	publicKey: P256PublicKey;
	validUntilEpochMs?: number;
}

export interface LabelerDidResolverLike {
	resolve(did: Did): Promise<unknown>;
}

interface CachedIdentity {
	endpoint: string;
	signingKey: string;
	signingKeyId: string;
	resolvedAt: Date;
}

export class LabelerResolver {
	constructor(
		private readonly db: D1Database,
		private readonly resolver: LabelerDidResolverLike,
		private readonly ttlMs = DEFAULT_TTL_MS,
		private readonly now: () => Date = () => new Date(),
	) {}

	resolve(did: string): Promise<ResolvedLabelerIdentity> {
		return this.resolveInternal(asDid(did), false);
	}

	resolveFresh(did: string): Promise<ResolvedLabelerIdentity> {
		return this.resolveInternal(asDid(did), true);
	}

	async verificationKeys(did: string): Promise<readonly ResolvedLabelVerificationKey[]> {
		const source = asDid(did);
		const current = await this.db
			.prepare(
				`SELECT signing_key FROM labellers
				 WHERE did = ? AND active = 1 AND signing_key <> ''`,
			)
			.bind(source)
			.first<{ signing_key: string }>();
		if (!current) return [];
		const history = await this.db
			.prepare(`SELECT signing_key, last_seen_at FROM labeler_signing_keys WHERE did = ?`)
			.bind(source)
			.all<{ signing_key: string; last_seen_at: string }>();
		const keys: ResolvedLabelVerificationKey[] = [];
		let includedCurrent = false;
		for (const row of history.results ?? []) {
			const publicKey = await importKey(row.signing_key);
			if (row.signing_key === current.signing_key) {
				keys.push({ publicKey });
				includedCurrent = true;
				continue;
			}
			const validUntilEpochMs = Date.parse(row.last_seen_at);
			if (!Number.isFinite(validUntilEpochMs)) {
				throw new TypeError("retained labeler key has an invalid validity boundary");
			}
			keys.push({ publicKey, validUntilEpochMs });
		}
		if (!includedCurrent) keys.push({ publicKey: await importKey(current.signing_key) });
		return keys;
	}

	private async resolveInternal(did: Did, fresh: boolean): Promise<ResolvedLabelerIdentity> {
		const cached = await this.read(did);
		if (!cached) throw new Error(`labeler is not configured: ${did}`);
		if (!fresh && this.now().getTime() - cached.resolvedAt.getTime() < this.ttlMs) {
			return materialize(cached, did, this.ttlMs);
		}
		const identity = await extractIdentity(await this.resolver.resolve(did), did);
		const resolvedAt = this.now();
		const statements = [
			this.db
				.prepare(
					`UPDATE labellers SET endpoint = ?, signing_key = ?, signing_key_id = ?,
				 last_resolved_at = ? WHERE did = ? AND active = 1`,
				)
				.bind(
					identity.endpoint,
					identity.signingKey,
					identity.signingKeyId,
					resolvedAt.toISOString(),
					did,
				),
			this.db
				.prepare(
					`INSERT INTO labeler_signing_keys
					   (did, signing_key, first_seen_at, last_seen_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(did, signing_key) DO UPDATE SET
					   last_seen_at = excluded.last_seen_at`,
				)
				.bind(did, identity.signingKey, resolvedAt.toISOString(), resolvedAt.toISOString()),
		];
		if (cached.signingKey !== "") {
			statements.push(
				this.db
					.prepare(
						`INSERT INTO labeler_signing_keys
						   (did, signing_key, first_seen_at, last_seen_at)
						 VALUES (?, ?, ?, ?)
						 ON CONFLICT(did, signing_key) DO UPDATE SET
						   last_seen_at = excluded.last_seen_at`,
					)
					.bind(did, cached.signingKey, cached.resolvedAt.toISOString(), resolvedAt.toISOString()),
			);
		}
		const [update] = await this.db.batch(statements);
		if (update?.meta.changes !== 1) throw new Error(`labeler is not configured: ${did}`);
		return materialize({ ...identity, resolvedAt }, did, this.ttlMs);
	}

	private async read(did: string): Promise<CachedIdentity | null> {
		const row = await this.db
			.prepare(
				`SELECT endpoint, signing_key, signing_key_id, last_resolved_at
				 FROM labellers WHERE did = ? AND active = 1`,
			)
			.bind(did)
			.first<{
				endpoint: string;
				signing_key: string;
				signing_key_id: string;
				last_resolved_at: string;
			}>();
		return row
			? {
					endpoint: row.endpoint,
					signingKey: row.signing_key,
					signingKeyId: row.signing_key_id,
					resolvedAt: new Date(row.last_resolved_at),
				}
			: null;
	}
}

function asDid(value: string): Did {
	if (!isDid(value)) throw new TypeError("labeler source must be a DID");
	return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${field} must be an object`);
	}
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		result[key] = Object.getOwnPropertyDescriptor(value, key)?.value;
	}
	return result;
}

function normalizedId(did: string, value: string): string {
	return value.startsWith("#") ? `${did}${value}` : value;
}

function exactlyOne(
	value: unknown,
	did: string,
	id: string,
	field: string,
): Record<string, unknown> {
	if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
	const matches = value
		.map((entry) => object(entry, field))
		.filter((entry) => typeof entry["id"] === "string" && normalizedId(did, entry["id"]) === id);
	if (matches.length !== 1) throw new TypeError(`${field} must contain exactly one ${id}`);
	return matches[0]!;
}

async function extractIdentity(
	value: unknown,
	did: string,
): Promise<Omit<CachedIdentity, "resolvedAt">> {
	const document = object(value, "DID document");
	if (document["id"] !== did) throw new TypeError("DID document id does not match labeler DID");
	const service = exactlyOne(document["service"], did, `${did}#atproto_labeler`, "service");
	if (service["type"] !== "AtprotoLabeler") {
		throw new TypeError("#atproto_labeler service must have type AtprotoLabeler");
	}
	const endpoint = endpointUrl(service["serviceEndpoint"]);
	const method = exactlyOne(
		document["verificationMethod"],
		did,
		`${did}#atproto_label`,
		"verificationMethod",
	);
	if (method["type"] !== "Multikey" || method["controller"] !== did) {
		throw new TypeError("#atproto_label must be a controller-owned Multikey");
	}
	if (typeof method["publicKeyMultibase"] !== "string") {
		throw new TypeError("#atproto_label has no publicKeyMultibase");
	}
	await importKey(method["publicKeyMultibase"]);
	return {
		endpoint,
		signingKey: method["publicKeyMultibase"],
		signingKeyId: `${did}#atproto_label`,
	};
}

function endpointUrl(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("labeler endpoint must be HTTPS");
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.hash) {
		throw new TypeError("labeler endpoint must be an HTTPS URL without credentials or fragment");
	}
	return url.href.replace(TRAILING_SLASH, "");
}

async function importKey(multikey: string): Promise<P256PublicKey> {
	const parsed = parsePublicMultikey(multikey);
	if (
		parsed.type !== "p256" ||
		parsed.publicKeyBytes.length !== 33 ||
		(parsed.publicKeyBytes[0] !== 2 && parsed.publicKeyBytes[0] !== 3)
	) {
		throw new TypeError("#atproto_label must contain a compressed P-256 key");
	}
	const key = await P256PublicKey.importRaw(parsed.publicKeyBytes);
	if ((await key.exportPublicKey("multikey")) !== multikey) {
		throw new TypeError("#atproto_label key is not canonical");
	}
	return key;
}

async function materialize(
	identity: CachedIdentity,
	did: string,
	ttlMs: number,
): Promise<ResolvedLabelerIdentity> {
	if (identity.signingKeyId !== `${did}#atproto_label`) {
		throw new TypeError("cached labeler signing key id is invalid");
	}
	return {
		endpoint: endpointUrl(identity.endpoint),
		publicKey: await importKey(identity.signingKey),
		signingKeyId: identity.signingKeyId,
		resolvedAtEpochMs: identity.resolvedAt.getTime(),
		expiresAtEpochMs: identity.resolvedAt.getTime() + ttlMs,
	};
}
