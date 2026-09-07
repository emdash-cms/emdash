import { base64url } from "jose";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_LEASE_MS = 5 * 60_000;

export interface PublicationCoordinationLease {
	packageSlug: string;
	intentId: string;
	generation: number;
	token: string;
	expiresAt: number;
}

export type AcquirePublicationCoordinationResult =
	| { ok: true; lease: PublicationCoordinationLease; replayed: boolean }
	| { ok: false; code: "PUBLICATION_COORDINATION_BUSY"; retryAt: number };

export interface RenewPublicationCoordinationInput {
	publisherDid: string;
	packageSlug: string;
	intentId: string;
	generation: number;
	token: string;
	leaseMs: number;
	now?: number;
}

export type RenewPublicationCoordinationResult =
	| { ok: true; lease: PublicationCoordinationLease }
	| { ok: false; code: "PUBLICATION_COORDINATION_REQUIRED" };

export interface ReleasePublicationCoordinationInput {
	publisherDid: string;
	packageSlug: string;
	intentId: string;
	generation: number;
	token: string;
	now?: number;
}

export type ReleasePublicationCoordinationResult =
	| { ok: true; replayed: boolean }
	| { ok: false; code: "PUBLICATION_COORDINATION_REQUIRED" };

interface CoordinationRow {
	[key: string]: string | number | ArrayBuffer | null;
	intent_id: string;
	generation: number;
	token_hash: string;
	expires_at: number;
}

export class PublicationCoordinationError extends Error {
	readonly code = "PUBLICATION_COORDINATION_INVALID";

	constructor() {
		super("PUBLICATION_COORDINATION_INVALID");
		this.name = "PublicationCoordinationError";
	}
}

async function hashToken(token: string): Promise<string> {
	return base64url.encode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
	);
}

function hashesEqual(left: string, right: string): boolean {
	try {
		const leftBytes = base64url.decode(left);
		const rightBytes = base64url.decode(right);
		return (
			leftBytes.length === rightBytes.length && crypto.subtle.timingSafeEqual(leftBytes, rightBytes)
		);
	} catch {
		return false;
	}
}

function validLeaseInput(
	publisherDid: string,
	packageSlug: string,
	intentId: string,
	leaseMs: number,
	token: string,
	now: number,
): boolean {
	return (
		DID_PATTERN.test(publisherDid) &&
		PACKAGE_SLUG_PATTERN.test(packageSlug) &&
		ULID_PATTERN.test(intentId) &&
		Number.isSafeInteger(leaseMs) &&
		leaseMs >= 1 &&
		leaseMs <= MAX_LEASE_MS &&
		TOKEN_PATTERN.test(token) &&
		Number.isSafeInteger(now) &&
		now >= 0 &&
		now <= Number.MAX_SAFE_INTEGER - leaseMs
	);
}

function validLeaseIdentity(
	publisherDid: string,
	packageSlug: string,
	intentId: string,
	generation: number,
	token: string,
	now: number,
): boolean {
	return (
		DID_PATTERN.test(publisherDid) &&
		PACKAGE_SLUG_PATTERN.test(packageSlug) &&
		ULID_PATTERN.test(intentId) &&
		Number.isSafeInteger(generation) &&
		generation >= 1 &&
		TOKEN_PATTERN.test(token) &&
		Number.isSafeInteger(now) &&
		now >= 0
	);
}

export function initializePublicationCoordinationSchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS publication_coordinations (
			package_slug TEXT PRIMARY KEY,
			intent_id TEXT NOT NULL,
			generation INTEGER NOT NULL CHECK (generation >= 1),
			token_hash TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			acquired_at INTEGER NOT NULL,
			renewed_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_publication_coordinations_expiry
			ON publication_coordinations(expires_at);
	`);
}

export class PublicationCoordinationStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	async acquire(
		publisherDid: string,
		packageSlug: string,
		intentId: string,
		leaseMs: number,
		token: string,
		now = Date.now(),
	): Promise<AcquirePublicationCoordinationResult> {
		if (!validLeaseInput(publisherDid, packageSlug, intentId, leaseMs, token, now)) {
			throw new PublicationCoordinationError();
		}
		const tokenHash = await hashToken(token);
		return this.storage.transactionSync(() => {
			const current = this.storage.sql
				.exec<CoordinationRow>(
					`SELECT intent_id, generation, token_hash, expires_at
					 FROM publication_coordinations WHERE package_slug = ?`,
					packageSlug,
				)
				.toArray()[0];
			if (
				current &&
				current.expires_at > now &&
				current.intent_id === intentId &&
				hashesEqual(current.token_hash, tokenHash)
			) {
				return {
					ok: true,
					lease: {
						packageSlug,
						intentId,
						generation: current.generation,
						token,
						expiresAt: current.expires_at,
					},
					replayed: true,
				} as const;
			}
			if (current && current.expires_at > now && current.intent_id !== intentId) {
				return {
					ok: false,
					code: "PUBLICATION_COORDINATION_BUSY",
					retryAt: current.expires_at,
				} as const;
			}
			const generation = (current?.generation ?? 0) + 1;
			const expiresAt = now + leaseMs;
			this.storage.sql.exec(
				`INSERT INTO publication_coordinations (
					package_slug, intent_id, generation, token_hash, expires_at, acquired_at, renewed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(package_slug) DO UPDATE SET
					intent_id = excluded.intent_id,
					generation = excluded.generation,
					token_hash = excluded.token_hash,
					expires_at = excluded.expires_at,
					acquired_at = excluded.acquired_at,
					renewed_at = excluded.renewed_at`,
				packageSlug,
				intentId,
				generation,
				tokenHash,
				expiresAt,
				now,
				now,
			);
			this.storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES ('publication-coordination-acquired', 'system',
				          'release-service', ?, NULL, '{}', ?)`,
				`${packageSlug}:${intentId}`,
				now,
			);
			return {
				ok: true,
				lease: { packageSlug, intentId, generation, token, expiresAt },
				replayed: false,
			} as const;
		});
	}

	async renew(
		input: RenewPublicationCoordinationInput,
	): Promise<RenewPublicationCoordinationResult> {
		const now = input.now ?? Date.now();
		if (
			!validLeaseInput(
				input.publisherDid,
				input.packageSlug,
				input.intentId,
				input.leaseMs,
				input.token,
				now,
			) ||
			!Number.isSafeInteger(input.generation) ||
			input.generation < 1
		) {
			throw new PublicationCoordinationError();
		}
		const tokenHash = await hashToken(input.token);
		return this.storage.transactionSync(() => {
			const current = this.storage.sql
				.exec<CoordinationRow>(
					`SELECT intent_id, generation, token_hash, expires_at
					 FROM publication_coordinations WHERE package_slug = ?`,
					input.packageSlug,
				)
				.toArray()[0];
			if (
				!current ||
				current.intent_id !== input.intentId ||
				current.generation !== input.generation ||
				!hashesEqual(current.token_hash, tokenHash) ||
				current.expires_at <= now
			) {
				return { ok: false, code: "PUBLICATION_COORDINATION_REQUIRED" } as const;
			}
			const expiresAt = now + input.leaseMs;
			this.storage.sql.exec(
				`UPDATE publication_coordinations SET expires_at = ?, renewed_at = ?
				 WHERE package_slug = ?`,
				expiresAt,
				now,
				input.packageSlug,
			);
			return {
				ok: true,
				lease: {
					packageSlug: input.packageSlug,
					intentId: input.intentId,
					generation: input.generation,
					token: input.token,
					expiresAt,
				},
			} as const;
		});
	}

	async release(
		input: ReleasePublicationCoordinationInput,
	): Promise<ReleasePublicationCoordinationResult> {
		const now = input.now ?? Date.now();
		if (
			!validLeaseIdentity(
				input.publisherDid,
				input.packageSlug,
				input.intentId,
				input.generation,
				input.token,
				now,
			)
		) {
			throw new PublicationCoordinationError();
		}
		const tokenHash = await hashToken(input.token);
		return this.storage.transactionSync(() => {
			const current = this.storage.sql
				.exec<CoordinationRow>(
					`SELECT intent_id, generation, token_hash, expires_at
					 FROM publication_coordinations WHERE package_slug = ?`,
					input.packageSlug,
				)
				.toArray()[0];
			if (!current) return { ok: true, replayed: true } as const;
			if (
				current.intent_id !== input.intentId ||
				current.generation !== input.generation ||
				!hashesEqual(current.token_hash, tokenHash)
			) {
				return { ok: false, code: "PUBLICATION_COORDINATION_REQUIRED" } as const;
			}
			this.storage.sql.exec(
				"DELETE FROM publication_coordinations WHERE package_slug = ?",
				input.packageSlug,
			);
			this.storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES ('publication-coordination-released', 'system',
				          'release-service', ?, NULL, '{}', ?)`,
				`${input.packageSlug}:${input.intentId}`,
				now,
			);
			return { ok: true, replayed: false } as const;
		});
	}

	recoverExpired(now = Date.now()): number {
		if (!Number.isSafeInteger(now) || now < 0) throw new PublicationCoordinationError();
		return this.storage.sql
			.exec(
				"DELETE FROM publication_coordinations WHERE expires_at <= ? RETURNING package_slug",
				now,
			)
			.toArray().length;
	}

	nextDeadline(): number | null {
		return this.storage.sql
			.exec<{ expires_at: number | null }>(
				"SELECT MIN(expires_at) AS expires_at FROM publication_coordinations",
			)
			.one().expires_at;
	}
}
