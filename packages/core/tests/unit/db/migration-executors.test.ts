import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MIGRATION_NAMES } from "../../../src/database/migrations/runner.js";
import { createMigrationExecutor as createLibsqlExecutor } from "../../../src/db/libsql-migrations.js";
import { createMigrationExecutor as createPostgresExecutor } from "../../../src/db/postgres-migrations.js";
import { createMigrationExecutor as createSqliteExecutor } from "../../../src/db/sqlite-migrations.js";
import { getCoreMigrationIdentity } from "../../../src/migrations/identity.js";
import type {
	MigrationExecutorFactoryContext,
	MigrationRequest,
} from "../../../src/migrations/protocol.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "emdash-migrations-"));
	temporaryDirectories.push(directory);
	return directory;
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

function context(
	projectRoot: string,
	env: Readonly<Record<string, string | undefined>> = {},
): MigrationExecutorFactoryContext {
	return { projectRoot, env };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("SQLite migration executor", () => {
	it("resolves relative paths from the project and opens the database only on execution", async () => {
		const projectRoot = await temporaryDirectory();
		await mkdir(join(projectRoot, "data"));
		const databasePath = join(projectRoot, "data", "deployment.db");
		const executor = await createSqliteExecutor(
			{ url: "file:./data/deployment.db" },
			context(projectRoot),
		);

		expect(existsSync(databasePath)).toBe(false);
		expect(executor.target).toEqual({
			kind: "sqlite",
			label: databasePath,
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(Object.isFrozen(executor.target)).toBe(true);

		const firstReport = await executor.execute(await migrationRequest("apply"));
		expect(existsSync(databasePath)).toBe(true);
		expect(firstReport.executed).toEqual(MIGRATION_NAMES);
		expect(firstReport.pending).toEqual([]);

		const secondExecutor = await createSqliteExecutor(
			{ url: "file:./data/deployment.db" },
			context(projectRoot),
		);
		const secondReport = await secondExecutor.execute(await migrationRequest("apply"));
		expect(secondReport.executed).toEqual([]);
		expect(secondReport.knownApplied).toEqual(MIGRATION_NAMES);
	}, 30_000);

	it("uses the explicit database override instead of the manifest path", async () => {
		const projectRoot = await temporaryDirectory();
		const overridePath = join(projectRoot, "override.db");
		const executor = await createSqliteExecutor(
			{ url: "manifest.db" },
			{
				...context(projectRoot),
				overrides: { database: "override.db" },
			},
		);

		expect(executor.target.label).toBe(overridePath);
		await executor.execute(await migrationRequest("check"));
		expect(existsSync(overridePath)).toBe(true);
		expect(existsSync(join(projectRoot, "manifest.db"))).toBe(false);
	});
});

describe("libSQL migration executor", () => {
	it("migrates a local file without reading a token and is idempotent", async () => {
		const projectRoot = await temporaryDirectory();
		const databasePath = join(projectRoot, "libsql.db");
		const manifestConfig = {
			url: "file:./libsql.db",
			authTokenEnv: "UNSET_TURSO_TOKEN",
		};
		const firstExecutor = await createLibsqlExecutor(manifestConfig, context(projectRoot));

		expect(existsSync(databasePath)).toBe(false);
		const firstReport = await firstExecutor.execute(await migrationRequest("apply"));
		expect(firstReport.executed).toEqual(MIGRATION_NAMES);
		expect(firstReport.pending).toEqual([]);

		const secondExecutor = await createLibsqlExecutor(manifestConfig, context(projectRoot));
		const secondReport = await secondExecutor.execute(await migrationRequest("apply"));
		expect(secondReport.executed).toEqual([]);
		expect(secondReport.knownApplied).toEqual(MIGRATION_NAMES);
	}, 30_000);

	it("fails on a missing token before constructing an executor", async () => {
		const projectRoot = await temporaryDirectory();

		await expect(
			createLibsqlExecutor(
				{ url: "libsql://example.turso.io/site", authTokenEnv: "DEPLOY_TURSO_TOKEN" },
				context(projectRoot),
			),
		).rejects.toThrow("DEPLOY_TURSO_TOKEN");
	});

	it("keeps credentials and URL parameters out of its safe target", async () => {
		const projectRoot = await temporaryDirectory();
		const secret = "very-secret-token";
		const executor = await createLibsqlExecutor(
			{
				url: "libsql://example.turso.io/site?tls=1#deployment",
				authTokenEnv: "DEPLOY_TURSO_TOKEN",
			},
			context(projectRoot, { DEPLOY_TURSO_TOKEN: secret }),
		);

		expect(executor.target.label).toBe("libsql://example.turso.io/site");
		expect(JSON.stringify(executor.target)).not.toContain(secret);
		expect(JSON.stringify(executor.target)).not.toContain("tls");
		expect(JSON.stringify(executor.target)).not.toContain("deployment");
	});

	it("rejects URL credentials without echoing them", async () => {
		const projectRoot = await temporaryDirectory();
		const url = "libsql://alice:password@example.turso.io/site";

		let error: unknown;
		try {
			await createLibsqlExecutor(
				{ url, authTokenEnv: "DEPLOY_TURSO_TOKEN" },
				context(projectRoot, { DEPLOY_TURSO_TOKEN: "token" }),
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain("alice");
		expect((error as Error).message).not.toContain("password");
	});
});

describe("PostgreSQL migration executor", () => {
	it("fails on a missing connection string before constructing an executor", async () => {
		const projectRoot = await temporaryDirectory();

		await expect(
			createPostgresExecutor({ connectionStringEnv: "DEPLOY_DATABASE_URL" }, context(projectRoot)),
		).rejects.toThrow("DEPLOY_DATABASE_URL");
	});

	it("derives target identity only from host, port, and database", async () => {
		const projectRoot = await temporaryDirectory();
		const first = await createPostgresExecutor(
			{ connectionStringEnv: "DEPLOY_DATABASE_URL" },
			context(projectRoot, {
				DEPLOY_DATABASE_URL: "postgresql://alice:first-secret@db.example:5433/site?sslmode=require",
			}),
		);
		const second = await createPostgresExecutor(
			{ connectionStringEnv: "OTHER_DATABASE_URL" },
			context(projectRoot, {
				OTHER_DATABASE_URL: "postgresql://bob:second-secret@db.example:5433/site?sslmode=disable",
			}),
		);

		expect(first.target).toEqual({
			kind: "postgres",
			label: "db.example:5433/site",
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(second.target).toEqual(first.target);
		const serialized = JSON.stringify([first.target, second.target]);
		expect(serialized).not.toContain("alice");
		expect(serialized).not.toContain("bob");
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("sslmode");
	});

	it("uses the connection-string environment override", async () => {
		const projectRoot = await temporaryDirectory();
		const executor = await createPostgresExecutor(
			{ connectionStringEnv: "MANIFEST_DATABASE_URL" },
			{
				...context(projectRoot, {
					OVERRIDE_DATABASE_URL: "postgresql://db.example/override",
				}),
				overrides: { databaseUrlEnv: "OVERRIDE_DATABASE_URL" },
			},
		);

		expect(executor.target.label).toBe("db.example:5432/override");
	});
});
