import { type Dialect, Kysely } from "kysely";

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

function createReport(
	target: MigrationTarget,
	status: ExactMigrationStatus,
	executed: readonly string[],
): MigrationReport {
	return {
		target,
		knownApplied: [...status.knownApplied],
		pending: [...status.pending],
		unknownApplied: [...status.unknownApplied],
		executed: [...executed],
	};
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
		return createReport(target, initialStatus, []);
	}

	if (initialStatus.unknownApplied.length > 0) {
		throw new Error(
			`Cannot apply migrations with unknown applied migrations: ${initialStatus.unknownApplied.join(", ")}`,
		);
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

			if (request.action !== "check" && request.action !== "apply") {
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
