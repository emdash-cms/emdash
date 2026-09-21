import type { Kysely, MigrationLockOptions } from "kysely";
import { SqliteAdapter } from "kysely";
import { MIGRATION_LOCK_ID } from "kysely/migration";

import { isMissingTableError } from "../utils/db-errors.js";
import { MIGRATION_LOCK_BUSY_MESSAGE } from "./pg-migration-lock.js";

export const MIGRATION_LOCK_TABLE = "_emdash_migrations_lock";

const RELEASE_ATTEMPTS = 3;

const RELEASE_LOCK_DOCS_URL =
	"https://docs.emdashcms.com/deployment/core-migrations/#release-a-stuck-migration-lock";

export function migrationLockHeldMessage(heldSince: number): string {
	return (
		`The migration lock has been held since ${new Date(heldSince).toISOString()} (lock ${heldSince}). ` +
		"A migration may still be running; if none is, check the database and release the lock: " +
		RELEASE_LOCK_DOCS_URL
	);
}

/** When the lock was taken, as carried by the busy error of `LockingSqliteAdapter`. */
export function busyLockHeldSince(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const heldSince: unknown = Reflect.get(error, "heldSince");
	return typeof heldSince === "number" && heldSince > 0 ? heldSince : undefined;
}

/**
 * SQLite adapter that takes the migration lock in a database row, for a
 * database whose clients have no connection-level lock to share (D1).
 *
 * Kysely creates the lock table with a single row, but none of its adapters
 * writes to it. The holder stores the time it took the lock in `is_locked`
 * (0 means free) and clears the row only while it still holds that time. A
 * lock whose holder never released it stays until `clearMigrationLock` runs:
 * the holder may still be migrating, or may have stopped partway through a
 * migration.
 */
export class LockingSqliteAdapter extends SqliteAdapter {
	// eslint-disable-next-line typescript/no-explicit-any -- matches the DialectAdapter signature
	readonly #held = new WeakMap<Kysely<any>, number>();

	override async acquireMigrationLock(
		// eslint-disable-next-line typescript/no-explicit-any -- matches the DialectAdapter signature
		db: Kysely<any>,
		options: MigrationLockOptions,
	): Promise<void> {
		const heldSince = Date.now();
		const result = await db
			.updateTable(options.lockTable)
			.set({ is_locked: heldSince })
			.where("id", "=", options.lockRowId)
			.where("is_locked", "=", 0)
			.executeTakeFirst();
		if (result.numUpdatedRows !== 1n) {
			const row = await db
				.selectFrom(options.lockTable)
				.select("is_locked")
				.where("id", "=", options.lockRowId)
				.executeTakeFirst()
				.catch(() => undefined);
			throw Object.assign(new Error(MIGRATION_LOCK_BUSY_MESSAGE), {
				heldSince: Number(row?.is_locked ?? 0),
			});
		}
		this.#held.set(db, heldSince);
	}

	override async releaseMigrationLock(
		// eslint-disable-next-line typescript/no-explicit-any -- matches the DialectAdapter signature
		db: Kysely<any>,
		options: MigrationLockOptions,
	): Promise<void> {
		// Kysely also calls this after acquireMigrationLock threw.
		const heldSince = this.#held.get(db);
		if (heldSince === undefined) return;
		this.#held.delete(db);
		// A lock left behind by a successful run goes unnoticed until the next
		// pending migration, so a failed write is retried. The write is
		// conditional on this run's acquire time, so a retry after a write that
		// landed can still clear a lock another run took in the same millisecond.
		for (let attempt = 1; ; attempt++) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- retries are sequential
				await db
					.updateTable(options.lockTable)
					.set({ is_locked: 0 })
					.where("id", "=", options.lockRowId)
					.where("is_locked", "=", heldSince)
					.execute();
				return;
			} catch (error) {
				if (attempt === RELEASE_ATTEMPTS) throw error;
			}
		}
	}
}

/**
 * When the migration lock was taken, in milliseconds since the epoch, or null
 * when it is free. Only `LockingSqliteAdapter` writes the lock row.
 */
export async function readMigrationLock(
	// eslint-disable-next-line typescript/no-explicit-any -- reads a table outside the Database type
	db: Kysely<any>,
): Promise<number | null> {
	try {
		const row = await db
			.selectFrom(MIGRATION_LOCK_TABLE)
			.select("is_locked")
			.where("id", "=", MIGRATION_LOCK_ID)
			.executeTakeFirst();
		const heldSince = Number(row?.is_locked ?? 0);
		return heldSince > 0 ? heldSince : null;
	} catch (error) {
		if (isMissingTableError(error)) return null;
		throw error;
	}
}

/**
 * Release a lock its holder never released. The row is cleared only while it
 * still holds `heldSince`, so a lock taken again since it was read stays
 * unless it was taken in that same millisecond.
 */
export async function clearMigrationLock(
	// eslint-disable-next-line typescript/no-explicit-any -- writes a table outside the Database type
	db: Kysely<any>,
	heldSince: number,
): Promise<boolean> {
	const result = await db
		.updateTable(MIGRATION_LOCK_TABLE)
		.set({ is_locked: 0 })
		.where("id", "=", MIGRATION_LOCK_ID)
		.where("is_locked", "=", heldSince)
		.executeTakeFirst();
	return result.numUpdatedRows > 0n;
}
