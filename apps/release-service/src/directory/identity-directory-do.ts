import { DurableObject } from "cloudflare:workers";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const SHARD_PATTERN = /^[0-9a-f]{2}$/;

export type DirectoryIdentityKind = "approver" | "publisher";

export interface DirectoryIdentity {
	kind: DirectoryIdentityKind;
	did: string;
	registeredAt: number;
	lastSeenAt: number;
}

export type DirectoryErrorCode =
	| "DIRECTORY_INPUT_INVALID"
	| "DIRECTORY_SHARD_INVALID"
	| "DIRECTORY_SHARD_MISMATCH";

export class DirectoryError extends Error {
	constructor(readonly code: DirectoryErrorCode) {
		super(code);
		this.name = "DirectoryError";
	}
}

interface DirectoryRow {
	[key: string]: string | number | ArrayBuffer | null;
	kind: DirectoryIdentityKind;
	did: string;
	registered_at: number;
	last_seen_at: number;
}

async function expectedShard(did: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(did)),
	);
	return digest[0]!.toString(16).padStart(2, "0");
}

function validKind(value: unknown): value is DirectoryIdentityKind {
	return value === "approver" || value === "publisher";
}

export class IdentityDirectoryDurableObject extends DurableObject<Env> {
	readonly #shard: string;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (ctx.id.name === undefined || !SHARD_PATTERN.test(ctx.id.name)) {
			throw new DirectoryError("DIRECTORY_SHARD_INVALID");
		}
		this.#shard = ctx.id.name;
		void ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS identities (
					kind TEXT NOT NULL CHECK (kind IN ('approver', 'publisher')),
					did TEXT NOT NULL,
					registered_at INTEGER NOT NULL,
					last_seen_at INTEGER NOT NULL,
					PRIMARY KEY (kind, did)
				);
				CREATE INDEX IF NOT EXISTS idx_directory_last_seen
					ON identities(kind, last_seen_at, did);
			`);
		});
	}

	async register(
		kind: DirectoryIdentityKind,
		did: string,
		now = Date.now(),
	): Promise<{ created: boolean; identity: DirectoryIdentity }> {
		if (!validKind(kind) || !DID_PATTERN.test(did) || !Number.isSafeInteger(now) || now < 0) {
			throw new DirectoryError("DIRECTORY_INPUT_INVALID");
		}
		if ((await expectedShard(did)) !== this.#shard) {
			throw new DirectoryError("DIRECTORY_SHARD_MISMATCH");
		}
		return this.ctx.storage.transactionSync(() => {
			const existing = this.ctx.storage.sql
				.exec<DirectoryRow>(
					`SELECT kind, did, registered_at, last_seen_at FROM identities
					 WHERE kind = ? AND did = ?`,
					kind,
					did,
				)
				.toArray()[0];
			if (existing) {
				this.ctx.storage.sql.exec(
					"UPDATE identities SET last_seen_at = MAX(last_seen_at, ?) WHERE kind = ? AND did = ?",
					now,
					kind,
					did,
				);
				return {
					created: false,
					identity: {
						kind,
						did,
						registeredAt: existing.registered_at,
						lastSeenAt: Math.max(existing.last_seen_at, now),
					},
				};
			}
			this.ctx.storage.sql.exec(
				"INSERT INTO identities (kind, did, registered_at, last_seen_at) VALUES (?, ?, ?, ?)",
				kind,
				did,
				now,
				now,
			);
			return { created: true, identity: { kind, did, registeredAt: now, lastSeenAt: now } };
		});
	}

	list(
		kind: DirectoryIdentityKind,
		afterDid: string | null,
		limit: number,
	): readonly DirectoryIdentity[] {
		if (
			!validKind(kind) ||
			(afterDid !== null && !DID_PATTERN.test(afterDid)) ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 100
		) {
			throw new DirectoryError("DIRECTORY_INPUT_INVALID");
		}
		return this.ctx.storage.sql
			.exec<DirectoryRow>(
				`SELECT kind, did, registered_at, last_seen_at FROM identities
				 WHERE kind = ? AND (? IS NULL OR did > ?) ORDER BY did LIMIT ?`,
				kind,
				afterDid,
				afterDid,
				limit,
			)
			.toArray()
			.map((row) => ({
				kind: row.kind,
				did: row.did,
				registeredAt: row.registered_at,
				lastSeenAt: row.last_seen_at,
			}));
	}
}
