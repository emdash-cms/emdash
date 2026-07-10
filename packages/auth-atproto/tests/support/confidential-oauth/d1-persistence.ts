import { AsyncLocalStorage } from "node:async_hooks";

import type { LockFunction, StoredSession, StoredState, Store } from "@atcute/oauth-node-client";

const SESSION_NAMESPACE = "sessions";
const LEASE_DURATION_MS = 35_000;
const LEASE_ACQUIRE_TIMEOUT_MS = 30_000;
const LEASE_RENEW_INTERVAL_MS = 10_000;

export interface D1OAuthPersistenceOptions {
	leaseDurationMs?: number;
	leaseAcquireTimeoutMs?: number;
	leaseRenewIntervalMs?: number;
}

interface LeaseContext {
	name: string;
	owner: string;
	lost: boolean;
}

export class D1OAuthPersistence {
	readonly sessions: Store<string, StoredSession>;
	readonly states: Store<string, StoredState>;
	readonly dpopNonces: Store<string, string>;
	readonly requestLock: LockFunction;
	leaseRenewalCount = 0;
	leaseRenewalLossCount = 0;

	readonly #db: D1Database;
	readonly #leaseContext = new AsyncLocalStorage<LeaseContext>();
	readonly #leaseDurationMs: number;
	readonly #leaseAcquireTimeoutMs: number;
	readonly #leaseRenewIntervalMs: number;

	constructor(db: D1Database, options: D1OAuthPersistenceOptions = {}) {
		this.#db = db;
		this.#leaseDurationMs = options.leaseDurationMs ?? LEASE_DURATION_MS;
		this.#leaseAcquireTimeoutMs = options.leaseAcquireTimeoutMs ?? LEASE_ACQUIRE_TIMEOUT_MS;
		this.#leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? LEASE_RENEW_INTERVAL_MS;
		this.sessions = this.#store<StoredSession>(SESSION_NAMESPACE);
		this.states = this.#store<StoredState>("states");
		this.dpopNonces = this.#store("dpop-nonces");
		this.requestLock = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
			const owner = crypto.randomUUID();
			await this.#acquireLease(name, owner);
			const context: LeaseContext = { name, owner, lost: false };
			const renewalStop = deferred();
			const renewal = this.#renewLease(context, renewalStop.promise);
			try {
				return await this.#leaseContext.run(context, operation);
			} finally {
				renewalStop.resolve();
				try {
					await renewal;
				} finally {
					await this.#db
						.prepare(
							"UPDATE oauth_session_leases SET owner = NULL, expires_at = 0 WHERE name = ? AND owner = ?",
						)
						.bind(name, owner)
						.run();
				}
			}
		};
	}

	#store<T>(namespace: string): Store<string, T> {
		return {
			get: async (key): Promise<T | undefined> => {
				const row = await this.#db
					.prepare("SELECT value FROM oauth_values WHERE namespace = ? AND key = ?")
					.bind(namespace, key)
					.first<{ value: string }>();
				return row ? (JSON.parse(row.value) as T) : undefined;
			},
			set: async (key, value): Promise<void> => {
				const serialized = JSON.stringify(value);
				const lockName = `oauth-session-${key}`;
				const owner = this.#sessionLeaseOwner(namespace, lockName);

				if (owner) {
					const result = await this.#db
						.prepare(
							`INSERT INTO oauth_values (namespace, key, value)
							 SELECT ?, ?, ?
							 WHERE EXISTS (
							   SELECT 1 FROM oauth_session_leases
							   WHERE name = ? AND owner = ? AND expires_at > ?
							 )
							 ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`,
						)
						.bind(namespace, key, serialized, lockName, owner, Date.now())
						.run();
					if (result.meta.changes !== 1) {
						throw new Error("OAuth session lease was lost before the rotated token was persisted");
					}
					return;
				}

				if (namespace === SESSION_NAMESPACE) {
					const result = await this.#db
						.prepare(
							"INSERT INTO oauth_values (namespace, key, value) VALUES (?, ?, ?) ON CONFLICT(namespace, key) DO NOTHING",
						)
						.bind(namespace, key, serialized)
						.run();
					if (result.meta.changes !== 1) {
						throw new Error("Ownerless OAuth session creation cannot replace an existing session");
					}
					return;
				}

				await this.#db
					.prepare(
						`INSERT INTO oauth_values (namespace, key, value) VALUES (?, ?, ?)
						 ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`,
					)
					.bind(namespace, key, serialized)
					.run();
			},
			delete: async (key): Promise<void> => {
				const lockName = `oauth-session-${key}`;
				const owner = this.#sessionLeaseOwner(namespace, lockName);
				if (owner) {
					const now = Date.now();
					const result = await this.#db
						.prepare(
							`DELETE FROM oauth_values
							 WHERE namespace = ? AND key = ?
							 AND EXISTS (
							   SELECT 1 FROM oauth_session_leases
							   WHERE name = ? AND owner = ? AND expires_at > ?
							 )`,
						)
						.bind(namespace, key, lockName, owner, now)
						.run();
					if (result.meta.changes === 0 && !(await this.#ownsLease(lockName, owner, now))) {
						throw new Error("OAuth session lease was lost before the stored session was deleted");
					}
					return;
				}

				if (namespace === SESSION_NAMESPACE) {
					const existing = await this.#db
						.prepare("SELECT 1 AS present FROM oauth_values WHERE namespace = ? AND key = ?")
						.bind(namespace, key)
						.first<{ present: number }>();
					if (existing) {
						throw new Error("Ownerless OAuth session deletion requires coordinated service logic");
					}
					return;
				}

				await this.#db
					.prepare("DELETE FROM oauth_values WHERE namespace = ? AND key = ?")
					.bind(namespace, key)
					.run();
			},
			clear: async (): Promise<void> => {
				if (namespace === SESSION_NAMESPACE) {
					const existing = await this.#db
						.prepare("SELECT 1 AS present FROM oauth_values WHERE namespace = ? LIMIT 1")
						.bind(namespace)
						.first<{ present: number }>();
					if (existing) {
						throw new Error("OAuth session clearing requires coordinated service logic");
					}
					return;
				}

				await this.#db
					.prepare("DELETE FROM oauth_values WHERE namespace = ?")
					.bind(namespace)
					.run();
			},
		};
	}

	#sessionLeaseOwner(namespace: string, expectedLockName: string): string | undefined {
		if (namespace !== SESSION_NAMESPACE) return undefined;
		const context = this.#leaseContext.getStore();
		if (!context) return undefined;
		if (context.name !== expectedLockName) {
			throw new Error(`OAuth session mutation does not match active lease: ${context.name}`);
		}
		if (context.lost) {
			throw new Error("OAuth session lease renewal lost ownership");
		}
		return context.owner;
	}

	async #renewLease(context: LeaseContext, stop: Promise<void>): Promise<void> {
		while (true) {
			const stopped = await Promise.race([
				stop.then(() => true),
				new Promise<false>((resolve) => setTimeout(resolve, this.#leaseRenewIntervalMs, false)),
			]);
			if (stopped) return;

			const now = Date.now();
			const result = await this.#db
				.prepare(
					`UPDATE oauth_session_leases
					 SET expires_at = ?
					 WHERE name = ? AND owner = ? AND expires_at > ?`,
				)
				.bind(now + this.#leaseDurationMs, context.name, context.owner, now)
				.run();
			if (result.meta.changes !== 1) {
				context.lost = true;
				this.leaseRenewalLossCount++;
				return;
			}
			this.leaseRenewalCount++;
		}
	}

	async #ownsLease(name: string, owner: string, now: number): Promise<boolean> {
		const row = await this.#db
			.prepare(
				"SELECT 1 AS owned FROM oauth_session_leases WHERE name = ? AND owner = ? AND expires_at > ?",
			)
			.bind(name, owner, now)
			.first<{ owned: number }>();
		return row?.owned === 1;
	}

	async #acquireLease(name: string, owner: string): Promise<void> {
		await this.#db
			.prepare("INSERT OR IGNORE INTO oauth_session_leases (name) VALUES (?)")
			.bind(name)
			.run();

		const deadline = Date.now() + this.#leaseAcquireTimeoutMs;
		while (Date.now() < deadline) {
			const now = Date.now();
			const result = await this.#db
				.prepare(
					`UPDATE oauth_session_leases
					 SET owner = ?, expires_at = ?
					 WHERE name = ? AND (owner IS NULL OR expires_at <= ?)`,
				)
				.bind(owner, now + this.#leaseDurationMs, name, now)
				.run();
			if (result.meta.changes === 1) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		throw new Error(`Timed out acquiring OAuth session lease: ${name}`);
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
