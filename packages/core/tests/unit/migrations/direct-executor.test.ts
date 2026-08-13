import Database from "better-sqlite3";
import type {
	CompiledQuery,
	DatabaseConnection,
	DatabaseIntrospector,
	Dialect,
	Driver,
	QueryResult,
} from "kysely";
import { SqliteAdapter, SqliteDialect, SqliteQueryCompiler } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MIGRATION_NAMES } from "../../../src/database/migrations/runner.js";
import { getI18nConfig, setI18nConfig, type I18nConfig } from "../../../src/i18n/config.js";
import { createDirectMigrationExecutor } from "../../../src/migrations/direct-executor.js";
import { getCoreMigrationIdentity } from "../../../src/migrations/identity.js";
import type { MigrationRequest, MigrationTarget } from "../../../src/migrations/protocol.js";

const TARGET: MigrationTarget = {
	kind: "sqlite",
	label: "test database",
	fingerprint: "target-fingerprint",
};

interface DialectTracker {
	factoryCalls: number;
	closeCalls: number;
	i18nAtConnection: Array<I18nConfig | null>;
}

interface TrackedDialectOptions {
	setup?: (database: Database.Database) => void;
	closeError?: Error;
}

function createTrackedDialectFactory(options: TrackedDialectOptions = {}): {
	tracker: DialectTracker;
	createDialect: () => Dialect;
} {
	const tracker: DialectTracker = {
		factoryCalls: 0,
		closeCalls: 0,
		i18nAtConnection: [],
	};

	return {
		tracker,
		createDialect() {
			tracker.factoryCalls += 1;
			const database = new Database(":memory:");
			options.setup?.(database);
			const close = database.close.bind(database);
			database.close = () => {
				tracker.closeCalls += 1;
				close();
				if (options.closeError) throw options.closeError;
			};

			return new SqliteDialect({
				database,
				onCreateConnection() {
					tracker.i18nAtConnection.push(getI18nConfig());
				},
			});
		},
	};
}

async function migrationRequest(action: MigrationRequest["action"]): Promise<MigrationRequest> {
	const identity = await getCoreMigrationIdentity();
	return {
		action,
		i18n: null,
		artifact: {
			emdashVersion: identity.emdashVersion,
			migrationSetFingerprint: identity.fingerprint,
		},
	};
}

afterEach(() => {
	setI18nConfig(null);
	vi.restoreAllMocks();
});

describe("createDirectMigrationExecutor", () => {
	it("checks a fresh database and destroys its only Kysely connection", async () => {
		const { tracker, createDialect } = createTrackedDialectFactory();
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });

		await expect(executor.execute(await migrationRequest("check"))).resolves.toEqual({
			target: TARGET,
			knownApplied: [],
			pending: MIGRATION_NAMES,
			unknownApplied: [],
			executed: [],
		});
		expect(tracker.factoryCalls).toBe(1);
		expect(tracker.closeCalls).toBe(1);
	});

	it("applies migrations with request i18n and restores the previous process config", async () => {
		const previousI18n: I18nConfig = {
			defaultLocale: "en",
			locales: ["en"],
		};
		const requestI18n: I18nConfig = {
			defaultLocale: "fr",
			locales: ["fr", "en"],
		};
		setI18nConfig(previousI18n);
		const { tracker, createDialect } = createTrackedDialectFactory();
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });
		const request = await migrationRequest("apply");
		request.i18n = requestI18n;

		await expect(executor.execute(request)).resolves.toEqual({
			target: TARGET,
			knownApplied: MIGRATION_NAMES,
			pending: [],
			unknownApplied: [],
			executed: MIGRATION_NAMES,
		});
		expect(tracker.i18nAtConnection).toEqual([requestI18n]);
		expect(getI18nConfig()).toBe(previousI18n);
		expect(tracker.factoryCalls).toBe(1);
		expect(tracker.closeCalls).toBe(1);
	});

	it.each([
		["version", { emdashVersion: "stale-version" }],
		["fingerprint", { migrationSetFingerprint: "stale-fingerprint" }],
	])("rejects an artifact %s mismatch before creating a dialect", async (_name, artifact) => {
		const { tracker, createDialect } = createTrackedDialectFactory();
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });
		const request = await migrationRequest("check");
		Object.assign(request.artifact, artifact);

		await expect(executor.execute(request)).rejects.toThrow(/artifact.*does not match/i);
		expect(tracker.factoryCalls).toBe(0);
		expect(tracker.closeCalls).toBe(0);
	});

	it("refuses unknown applied migrations without running known migrations", async () => {
		const { tracker, createDialect } = createTrackedDialectFactory({
			setup(database) {
				database.exec(`
					CREATE TABLE _emdash_migrations (
						name TEXT PRIMARY KEY,
						timestamp TEXT NOT NULL
					);
					INSERT INTO _emdash_migrations (name, timestamp)
					VALUES ('999_future', '2026-01-01T00:00:00.000Z');
				`);
			},
		});
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });

		await expect(executor.execute(await migrationRequest("apply"))).rejects.toThrow(
			/unknown applied migrations.*999_future/i,
		);
		expect(tracker.factoryCalls).toBe(1);
		expect(tracker.closeCalls).toBe(1);
	});

	it("refuses apply when every known migration and an unknown migration are recorded", async () => {
		const { tracker, createDialect } = createTrackedDialectFactory({
			setup(database) {
				database.exec(`
					CREATE TABLE _emdash_migrations (
						name TEXT PRIMARY KEY,
						timestamp TEXT NOT NULL
					)
				`);
				const insert = database.prepare(
					"INSERT INTO _emdash_migrations (name, timestamp) VALUES (?, ?)",
				);
				const insertAll = database.transaction((names: readonly string[]) => {
					for (const name of names) insert.run(name, "2026-01-01T00:00:00.000Z");
				});
				insertAll([...MIGRATION_NAMES, "999_future"]);
			},
		});
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });

		await expect(executor.execute(await migrationRequest("apply"))).rejects.toThrow(
			/unknown applied migrations.*999_future/i,
		);
		expect(tracker.closeCalls).toBe(1);
	});

	it("destroys the database and restores i18n after a status failure", async () => {
		const previousI18n: I18nConfig = { defaultLocale: "de", locales: ["de"] };
		setI18nConfig(previousI18n);
		const { tracker, createDialect } = createTrackedDialectFactory({
			setup(database) {
				database.exec("CREATE TABLE _emdash_migrations (unexpected TEXT)");
			},
		});
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });
		const request = await migrationRequest("check");
		request.i18n = { defaultLocale: "fr", locales: ["fr"] };

		await expect(executor.execute(request)).rejects.toThrow(/no such column.*name/i);
		expect(tracker.closeCalls).toBe(1);
		expect(getI18nConfig()).toBe(previousI18n);
	});

	it("destroys the database after a migration failure", async () => {
		const { tracker, createDialect } = createTrackedDialectFactory({
			setup(database) {
				const prepare = database.prepare.bind(database);
				database.prepare = ((source: string) => {
					if (/create table if not exists [`"]?revisions/i.test(source)) {
						throw new Error("injected migration failure");
					}
					return prepare(source);
				}) as typeof database.prepare;
			},
		});
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });

		await expect(executor.execute(await migrationRequest("apply"))).rejects.toThrow(
			/injected migration failure/i,
		);
		expect(tracker.closeCalls).toBe(1);
	});

	it("does not replace an execution failure with a destroy failure", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { tracker, createDialect } = createTrackedDialectFactory({
			setup(database) {
				database.exec("CREATE TABLE _emdash_migrations (unexpected TEXT)");
			},
			closeError: new Error("destroy failure"),
		});
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });

		await expect(executor.execute(await migrationRequest("check"))).rejects.toThrow(
			/no such column.*name/i,
		);
		expect(consoleError).toHaveBeenCalledWith("[migrations] Database close failed.");
		expect(JSON.stringify(consoleError.mock.calls)).not.toContain("destroy failure");
		expect(tracker.closeCalls).toBe(1);
	});

	it("returns a successful report when destroy fails", async () => {
		const destroyError = new Error("destroy failure");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { tracker, createDialect } = createTrackedDialectFactory({ closeError: destroyError });
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });

		await expect(executor.execute(await migrationRequest("check"))).resolves.toMatchObject({
			target: TARGET,
			pending: MIGRATION_NAMES,
		});
		expect(consoleError).toHaveBeenCalledWith("[migrations] Database close failed.");
		expect(tracker.closeCalls).toBe(1);
		await expect(executor.dispose?.()).resolves.toBeUndefined();
		expect(tracker.closeCalls).toBe(1);
	});

	it("is single-use even when its first execution fails identity verification", async () => {
		const { tracker, createDialect } = createTrackedDialectFactory();
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });
		const request = await migrationRequest("check");
		request.artifact.emdashVersion = "stale-version";

		await expect(executor.execute(request)).rejects.toThrow(/artifact.*does not match/i);
		await expect(executor.execute(await migrationRequest("check"))).rejects.toThrow(/single-use/i);
		expect(tracker.factoryCalls).toBe(0);
	});

	it("rejects a second execution after success without creating another dialect", async () => {
		const { tracker, createDialect } = createTrackedDialectFactory();
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });

		await executor.execute(await migrationRequest("check"));
		await expect(executor.execute(await migrationRequest("check"))).rejects.toThrow(/single-use/i);
		expect(tracker.factoryCalls).toBe(1);
		expect(tracker.closeCalls).toBe(1);
	});

	it("makes disposal idempotent and rejects execution after disposal", async () => {
		const { tracker, createDialect } = createTrackedDialectFactory();
		const executor = createDirectMigrationExecutor({ target: TARGET, createDialect });

		await executor.dispose?.();
		await executor.dispose?.();
		await expect(executor.execute(await migrationRequest("check"))).rejects.toThrow(/disposed/i);
		expect(tracker.factoryCalls).toBe(0);
	});

	it("destroys an active database when disposed during execution", async () => {
		let rejectQuery!: (error: Error) => void;
		const destroy = vi.fn(async () => rejectQuery(new Error("execution interrupted")));
		const queryStarted = vi.fn();
		const connection: DatabaseConnection = {
			executeQuery<Row>(_query: CompiledQuery): Promise<QueryResult<Row>> {
				queryStarted();
				return new Promise((_resolve, reject) => {
					rejectQuery = reject;
				});
			},
			// eslint-disable-next-line require-yield -- the test driver does not stream
			async *streamQuery<Row>(): AsyncIterableIterator<QueryResult<Row>> {
				throw new Error("Streaming is not supported");
			},
		};
		const driver: Driver = {
			init: async () => undefined,
			acquireConnection: async () => connection,
			beginTransaction: async () => undefined,
			commitTransaction: async () => undefined,
			rollbackTransaction: async () => undefined,
			releaseConnection: async () => undefined,
			destroy,
		};
		const dialect: Dialect = {
			createAdapter: () => new SqliteAdapter(),
			createDriver: () => driver,
			createIntrospector: (): DatabaseIntrospector => {
				throw new Error("Introspection is not supported");
			},
			createQueryCompiler: () => new SqliteQueryCompiler(),
		};
		const executor = createDirectMigrationExecutor({
			target: TARGET,
			createDialect: () => dialect,
		});
		const execution = executor.execute(await migrationRequest("check"));
		await vi.waitFor(() => expect(queryStarted).toHaveBeenCalledOnce());

		await executor.dispose?.();

		await expect(execution).rejects.toThrow("execution interrupted");
		expect(destroy).toHaveBeenCalledOnce();
	});

	it("snapshots its target before it can be confirmed or reported", async () => {
		const mutableTarget = { ...TARGET };
		const { createDialect } = createTrackedDialectFactory();
		const executor = createDirectMigrationExecutor({ target: mutableTarget, createDialect });
		mutableTarget.label = "changed target";

		expect(executor.target).toEqual(TARGET);
		expect(Object.isFrozen(executor.target)).toBe(true);
		const report = await executor.execute(await migrationRequest("check"));
		expect(report.target).toBe(executor.target);
	});
});
