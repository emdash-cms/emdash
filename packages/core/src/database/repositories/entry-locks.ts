import type { Kysely, RawBuilder } from "kysely";
import { sql } from "kysely";

import { isPostgres } from "../dialect-helpers.js";
import type { Database } from "../types.js";

export interface EntryLock {
	collection: string;
	entryId: string;
	userId: string;
	/** Display name of the holder, `null` when the account has none set. */
	userName: string | null;
	acquiredAt: string;
	expiresAt: string;
}

export type EntryLockClaim =
	| { outcome: "acquired"; lock: EntryLock }
	| { outcome: "held"; lock: EntryLock };

interface LockKey {
	collection: string;
	entryId: string;
	userId: string;
}

interface LeaseInput extends LockKey {
	leaseSeconds: number;
}

interface LockRow {
	collection: string;
	entry_id: string;
	user_id: string;
	token: string;
	acquired_at: string;
	expires_at: string;
}

/**
 * A refused claim proves a live lease existed at statement time, so a second
 * pass only runs when that lease lapsed or was released in between.
 */
const CLAIM_ATTEMPTS = 2;

function toEntryLock(row: LockRow & { user_name: string | null }): EntryLock {
	return {
		collection: row.collection,
		entryId: row.entry_id,
		userId: row.user_id,
		userName: row.user_name ?? null,
		acquiredAt: row.acquired_at,
		expiresAt: row.expires_at,
	};
}

/**
 * One lease per entry, keyed by `(collection, entry_id)`.
 *
 * Every timestamp comes from the database clock, so leases stay comparable
 * across isolates whose wall clocks drift.
 */
export class EntryLockRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Claims the entry for `userId`, or reports who holds it. An expired lease
	 * and the caller's own lease are both claimable; anyone else's live lease
	 * needs `takeover`.
	 *
	 * `token` identifies the caller's editing session. The row keeps the latest
	 * one and `release` matches on it, so two tabs of one account can share an
	 * entry without the first tab to close dropping the lease the other still
	 * relies on.
	 */
	async acquire(
		input: LeaseInput & { token: string; takeover?: boolean },
	): Promise<EntryLockClaim> {
		for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
			const claimed = await this.claim(input);
			if (claimed) return { outcome: "acquired", lock: await this.withHolderName(claimed) };

			const holder = await this.findLive(input.collection, input.entryId);
			if (holder) return { outcome: "held", lock: holder };
		}
		throw new Error(`Entry lock claim did not settle for ${input.collection}/${input.entryId}`);
	}

	/**
	 * Extends the caller's own live lease, and reports whether they had one.
	 * `false` lets a write path tell "mine, extended" from "someone else's, or
	 * none" without taking a lease it was never given.
	 */
	async refreshHeld(input: LeaseInput): Promise<boolean> {
		const result = await this.db
			.updateTable("_emdash_entry_locks")
			.set({ expires_at: this.timestampOffset(input.leaseSeconds) })
			.where("collection", "=", input.collection)
			.where("entry_id", "=", input.entryId)
			.where("user_id", "=", input.userId)
			.where(this.leaseIsLive("expires_at"))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	async findLive(collection: string, entryId: string): Promise<EntryLock | null> {
		const row = await this.liveQuery(collection, entryId).executeTakeFirst();
		return row ? toEntryLock(row) : null;
	}

	/** The live lease, but only while the collection still has locking switched on. */
	async findEnforceable(collection: string, entryId: string): Promise<EntryLock | null> {
		const row = await this.liveQuery(collection, entryId)
			.innerJoin(
				"_emdash_collections",
				"_emdash_collections.slug",
				"_emdash_entry_locks.collection",
			)
			.where("_emdash_collections.edit_locking", "!=", 0)
			.executeTakeFirst();
		return row ? toEntryLock(row) : null;
	}

	/**
	 * Drops the caller's lease. With `token`, only the session that last
	 * claimed the row can drop it; without, any session of the account can.
	 */
	async release(key: LockKey & { token?: string }): Promise<boolean> {
		let query = this.db
			.deleteFrom("_emdash_entry_locks")
			.where("collection", "=", key.collection)
			.where("entry_id", "=", key.entryId)
			.where("user_id", "=", key.userId);
		if (key.token !== undefined) query = query.where("token", "=", key.token);
		const result = await query.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0) > 0;
	}

	/** Drops every lease on an entry, whoever holds it. */
	async releaseEntry(collection: string, entryId: string): Promise<void> {
		await this.db
			.deleteFrom("_emdash_entry_locks")
			.where("collection", "=", collection)
			.where("entry_id", "=", entryId)
			.execute();
	}

	/**
	 * Insert-or-steal in one statement. The conflict branch keeps the original
	 * acquisition time when the holder is unchanged, so the admin can show how
	 * long the entry has been open rather than how long ago it was last typed
	 * into.
	 *
	 * Column references in the conflict branch are table-qualified: Postgres
	 * sees both the stored row and `excluded` there and rejects a bare name as
	 * ambiguous.
	 */
	private async claim(
		input: LeaseInput & { token: string; takeover?: boolean },
	): Promise<LockRow | undefined> {
		const now = this.timestampOffset(0);
		const expiresAt = this.timestampOffset(input.leaseSeconds);
		return this.db
			.insertInto("_emdash_entry_locks")
			.values({
				collection: input.collection,
				entry_id: input.entryId,
				user_id: input.userId,
				token: input.token,
				acquired_at: now,
				expires_at: expiresAt,
			})
			.onConflict((oc) => {
				const update = oc.columns(["collection", "entry_id"]).doUpdateSet({
					user_id: input.userId,
					token: input.token,
					acquired_at: sql<string>`CASE
						WHEN ${sql.ref("_emdash_entry_locks.user_id")} = ${input.userId}
						THEN ${sql.ref("_emdash_entry_locks.acquired_at")}
						ELSE ${now}
					END`,
					expires_at: expiresAt,
				});
				if (input.takeover === true) return update;
				return update.where((eb) =>
					eb.or([
						eb("_emdash_entry_locks.user_id", "=", input.userId),
						this.leaseHasExpired("_emdash_entry_locks.expires_at"),
					]),
				);
			})
			.returningAll()
			.executeTakeFirst();
	}

	private liveQuery(collection: string, entryId: string) {
		return this.db
			.selectFrom("_emdash_entry_locks")
			.leftJoin("users", "users.id", "_emdash_entry_locks.user_id")
			.select([
				"_emdash_entry_locks.collection",
				"_emdash_entry_locks.entry_id",
				"_emdash_entry_locks.user_id",
				"_emdash_entry_locks.token",
				"_emdash_entry_locks.acquired_at",
				"_emdash_entry_locks.expires_at",
				"users.name as user_name",
			])
			.where("_emdash_entry_locks.collection", "=", collection)
			.where("_emdash_entry_locks.entry_id", "=", entryId)
			.where(this.leaseIsLive("_emdash_entry_locks.expires_at"));
	}

	private async withHolderName(row: LockRow): Promise<EntryLock> {
		const user = await this.db
			.selectFrom("users")
			.select("name")
			.where("id", "=", row.user_id)
			.executeTakeFirst();
		return {
			collection: row.collection,
			entryId: row.entry_id,
			userId: row.user_id,
			userName: user?.name ?? null,
			acquiredAt: row.acquired_at,
			expiresAt: row.expires_at,
		};
	}

	private leaseIsLive(column: string) {
		const expiresAt = sql.ref(column);
		return isPostgres(this.db)
			? sql<boolean>`${expiresAt}::timestamptz > clock_timestamp()`
			: sql<boolean>`${expiresAt} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private leaseHasExpired(column: string) {
		const expiresAt = sql.ref(column);
		return isPostgres(this.db)
			? sql<boolean>`${expiresAt}::timestamptz <= clock_timestamp()`
			: sql<boolean>`${expiresAt} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private timestampOffset(offsetSeconds: number): RawBuilder<string> {
		if (isPostgres(this.db)) {
			return sql<string>`to_char(
				(clock_timestamp() AT TIME ZONE 'UTC') + (${offsetSeconds} * INTERVAL '1 second'),
				'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
			)`;
		}
		return sql<string>`strftime(
			'%Y-%m-%dT%H:%M:%fZ',
			'now',
			${`${offsetSeconds >= 0 ? "+" : ""}${offsetSeconds} seconds`}
		)`;
	}
}
