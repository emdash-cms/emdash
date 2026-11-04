import { type Dialect, Kysely } from "kysely";

import {
	armMigrationLockTakeOver,
	clearMigrationLock,
	readMigrationLock,
} from "../database/migration-lock.js";
import {
	getExactMigrationStatus,
	runMigrations,
	type ExactMigrationStatus,
} from "../database/migrations/runner.js";
import type { Database } from "../database/types.js";
import { getI18nConfig, setI18nConfig } from "../i18n/config.js";
import { getCoreMigrationIdentity } from "./identity.js";
import type {
	MigrationExecutor,
	MigrationReport,
	MigrationRequest,
	MigrationTarget,
} from "./protocol.js";

export interface DirectMigrationExecutorOptions {
	target: MigrationTarget;
	createDialect: () => Dialect | Promise<Dialect>;
}

const LOCK_ID_PATTERN = /^[1-9]\d{0,15}$/;

function createReport(
	target: MigrationTarget,
	status: ExactMigrationStatus,
	executed: readonly string[],
	lockHeldSince: number | null = null,
): MigrationReport {
	const report: MigrationReport = {
		target,
		knownApplied: [...status.knownApplied],
		pending: [...status.pending],
		unknownApplied: [...status.unknownApplied],
		executed: [...executed],
	};
	if (lockHeldSince !== null) {
		report.lock = {
			id: String(lockHeldSince),
			heldSince: new Date(lockHeldSince).toISOString(),
		};
	}
	return report;
}

function confirmedLockId(lockId: string | undefined): number {
	if (!lockId || !LOCK_ID_PATTERN.test(lockId)) {
		throw new Error("The migration lock id must be the one reported by status.");
	}
	return Number(lockId);
}

function lockMismatchError(current: number | null): Error {
	// No lock ids here: the CLI's redaction can rewrite digits that match an
	// environment value.
	return new Error(
		current === null
			? "The migration lock is not held."
			: "The migration lock has a different id now. Check the status again.",
	);
}

async function releaseLock(db: Kysely<Database>, lockId: string | undefined): Promise<void> {
	const lock = confirmedLockId(lockId);
	// Read before writing: on Postgres the lock column is a 32-bit integer that
	// a lock id does not fit, and no Postgres lock is ever held in it.
	const heldSince = await readMigrationLock(db);
	if (heldSince === lock && (await clearMigrationLock(db, lock))) return;
	throw lockMismatchError(heldSince === lock ? await readMigrationLock(db) : heldSince);
}

async function takeOverLock(
	db: Kysely<Database>,
	lockId: string | undefined,
	pending: boolean,
): Promise<void> {
	const lock = confirmedLockId(lockId);
	// With nothing pending no run takes the lock, so releasing it is enough.
	if (!pending) return releaseLock(db, lockId);
	const heldSince = await readMigrationLock(db);
	if (heldSince !== lock) throw lockMismatchError(heldSince);
	// No run on this database takes the lock in its row, so nothing can claim
	// it between the release and this run.
	if (!armMigrationLockTakeOver(db, lock)) await releaseLock(db, lockId);
}

async function verifyRequest(request: MigrationRequest): Promise<void> {
	const identity = await getCoreMigrationIdentity();
	if (
		request.artifact.emdashVersion !== identity.emdashVersion ||
		request.artifact.migrationSetFingerprint !== identity.fingerprint
	) {
		throw new Error(
			"Migration artifact does not match the loaded EmDash version and migration registry.",
		);
	}
}

async function executeRequest(
	db: Kysely<Database>,
	target: MigrationTarget,
	request: MigrationRequest,
): Promise<MigrationReport> {
	const initialStatus = await getExactMigrationStatus(db);
	if (request.action === "check") {
		return createReport(target, initialStatus, [], await readMigrationLock(db));
	}
	if (request.action === "release-lock") {
		await releaseLock(db, request.lockId);
		return createReport(target, initialStatus, []);
	}

	if (initialStatus.unknownApplied.length > 0) {
		throw new Error(
			`Cannot apply migrations with unknown applied migrations: ${initialStatus.unknownApplied.join(", ")}`,
		);
	}
	if (request.action === "take-over-lock") {
		await takeOverLock(db, request.lockId, initialStatus.pending.length > 0);
	}
	if (initialStatus.pending.length === 0) {
		return createReport(target, initialStatus, []);
	}

	const result = await runMigrations(db);
	const finalStatus = await getExactMigrationStatus(db);
	return createReport(target, finalStatus, result.applied);
}

export function createDirectMigrationExecutor(
	options: DirectMigrationExecutorOptions,
): MigrationExecutor {
	const target = Object.freeze({ ...options.target });
	let used = false;
	let disposed = false;
	let activeDb: Kysely<Database> | undefined;
	let closePromise: Promise<void> | undefined;

	const closeActiveDb = (): Promise<void> => {
		if (!activeDb) return Promise.resolve();
		closePromise ??= activeDb.destroy();
		return closePromise;
	};

	return {
		target,
		async execute(request) {
			if (disposed) {
				throw new Error("Migration executor has been disposed.");
			}
			if (used) {
				throw new Error("Migration executors are single-use.");
			}
			used = true;

			if (
				request.action !== "check" &&
				request.action !== "apply" &&
				request.action !== "release-lock" &&
				request.action !== "take-over-lock"
			) {
				throw new Error("Unsupported migration action.");
			}
			await verifyRequest(request);

			const dialect = await options.createDialect();
			const db = new Kysely<Database>({ dialect });
			activeDb = db;
			if (disposed) {
				await closeActiveDb();
				throw new Error("Migration executor has been disposed.");
			}
			const previousI18n = getI18nConfig();
			let executionFailed = false;
			let executionError: unknown;
			let report: MigrationReport | undefined;
			setI18nConfig(request.i18n);

			try {
				report = await executeRequest(db, target, request);
			} catch (error) {
				executionFailed = true;
				executionError = error;
			} finally {
				setI18nConfig(previousI18n);
				try {
					await closeActiveDb();
				} catch {
					console.error("[migrations] Database close failed.");
					closePromise = Promise.resolve();
				}
			}

			if (executionFailed) throw executionError;
			if (!report) throw new Error("Migration execution did not produce a report.");
			return report;
		},
		dispose() {
			disposed = true;
			return closeActiveDb();
		},
	};
}
