const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const WINDOW_MS = 60_000;
const MAX_IDEMPOTENCY_MS = 24 * 60 * 60_000;
const LIMITS = {
	publisher: 120,
	repository: 60,
	workload: 30,
} as const;

type RateLimitScope = keyof typeof LIMITS;

export interface ConsumeIntentRateLimitInput {
	publisherDid: string;
	repositoryId: string;
	workloadKey: string;
	idempotencyKey: string;
	expiresAt: number;
	now?: number;
}

export type ConsumeIntentRateLimitResult =
	| { ok: true; replayed: boolean; retryAt: number }
	| { ok: false; code: "RATE_LIMITED"; scope: RateLimitScope; retryAt: number };

export class IntentRateLimitError extends Error {
	constructor() {
		super("INTENT_RATE_LIMIT_INVALID");
		this.name = "IntentRateLimitError";
	}
}

interface RateWindowRow {
	[key: string]: string | number | ArrayBuffer | null;
	window_start: number;
	count: number;
}

interface IdempotencyRow {
	[key: string]: string | number | ArrayBuffer | null;
	expires_at: number;
}

export function initializeIntentRateLimitSchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS intent_rate_windows (
			scope TEXT NOT NULL CHECK (scope IN ('publisher', 'repository', 'workload')),
			subject_key TEXT NOT NULL,
			window_start INTEGER NOT NULL,
			count INTEGER NOT NULL CHECK (count >= 1),
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (scope, subject_key)
		);
		CREATE TABLE IF NOT EXISTS intent_rate_idempotency (
			workload_key TEXT NOT NULL,
			mutation_key TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (workload_key, mutation_key)
		);
		CREATE INDEX IF NOT EXISTS idx_intent_rate_idempotency_expiry
			ON intent_rate_idempotency(expires_at);
	`);
}

export class IntentRateLimitStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	consume(input: ConsumeIntentRateLimitInput): ConsumeIntentRateLimitResult {
		const now = input.now ?? Date.now();
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!DECIMAL_ID_PATTERN.test(input.repositoryId) ||
			!DIGEST_PATTERN.test(input.workloadKey) ||
			!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
			!Number.isSafeInteger(now) ||
			now < 0 ||
			!Number.isSafeInteger(input.expiresAt) ||
			input.expiresAt <= now ||
			input.expiresAt - now > MAX_IDEMPOTENCY_MS
		) {
			throw new IntentRateLimitError();
		}
		return this.storage.transactionSync(() => {
			const idempotency = this.storage.sql
				.exec<IdempotencyRow>(
					`SELECT expires_at FROM intent_rate_idempotency
					 WHERE workload_key = ? AND mutation_key = ?`,
					input.workloadKey,
					input.idempotencyKey,
				)
				.toArray()[0];
			const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
			const retryAt = windowStart + WINDOW_MS;
			if (idempotency && idempotency.expires_at > now) {
				return { ok: true, replayed: true, retryAt } as const;
			}
			if (idempotency) {
				this.storage.sql.exec(
					`DELETE FROM intent_rate_idempotency
					 WHERE workload_key = ? AND mutation_key = ?`,
					input.workloadKey,
					input.idempotencyKey,
				);
			}
			const subjects: ReadonlyArray<readonly [RateLimitScope, string]> = [
				["workload", input.workloadKey],
				["repository", input.repositoryId],
				["publisher", input.publisherDid],
			];
			for (const [scope, subject] of subjects) {
				const current = this.storage.sql
					.exec<RateWindowRow>(
						`SELECT window_start, count FROM intent_rate_windows
						 WHERE scope = ? AND subject_key = ?`,
						scope,
						subject,
					)
					.toArray()[0];
				const count = current?.window_start === windowStart ? current.count : 0;
				if (count >= LIMITS[scope]) {
					return { ok: false, code: "RATE_LIMITED", scope, retryAt } as const;
				}
			}
			for (const [scope, subject] of subjects) {
				this.storage.sql.exec(
					`INSERT INTO intent_rate_windows (
						scope, subject_key, window_start, count, updated_at
					) VALUES (?, ?, ?, 1, ?)
					ON CONFLICT(scope, subject_key) DO UPDATE SET
						window_start = excluded.window_start,
						count = CASE
							WHEN intent_rate_windows.window_start = excluded.window_start
							THEN intent_rate_windows.count + 1 ELSE 1 END,
						updated_at = excluded.updated_at`,
					scope,
					subject,
					windowStart,
					now,
				);
			}
			this.storage.sql.exec(
				`INSERT INTO intent_rate_idempotency (
					workload_key, mutation_key, expires_at, created_at
				) VALUES (?, ?, ?, ?)`,
				input.workloadKey,
				input.idempotencyKey,
				input.expiresAt,
				now,
			);
			this.storage.sql.exec("DELETE FROM intent_rate_idempotency WHERE expires_at <= ?", now);
			return { ok: true, replayed: false, retryAt } as const;
		});
	}
}
