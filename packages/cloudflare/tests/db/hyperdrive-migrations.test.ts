import { describe, expect, it } from "vitest";

import { createMigrationExecutor } from "../../src/db/hyperdrive-migrations.js";

const CONNECTION_ENV = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_PRIMARY_DB";

describe("Hyperdrive migration executor", () => {
	it("resolves a safe PostgreSQL origin identity without opening a connection", async () => {
		const executor = await createMigrationExecutor(
			{ binding: "PRIMARY_DB", connectionStringEnv: CONNECTION_ENV },
			{
				projectRoot: "/project",
				env: {
					[CONNECTION_ENV]:
						"postgresql://migration-user:super-secret@db.example.com:5444/content?sslmode=require&application_name=emdash",
				},
			},
		);

		expect(executor.target).toEqual({
			kind: "postgres",
			label: "db.example.com:5444/content",
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		const serialized = JSON.stringify(executor.target);
		expect(serialized).not.toContain("migration-user");
		expect(serialized).not.toContain("super-secret");
		expect(serialized).not.toContain("sslmode");
	});

	it("fails before opening a connection when the direct-origin variable is missing", async () => {
		await expect(
			createMigrationExecutor(
				{ binding: "PRIMARY_DB", connectionStringEnv: CONNECTION_ENV },
				{ projectRoot: "/project", env: {} },
			),
		).rejects.toThrow(CONNECTION_ENV);
	});

	it("honors the common database URL environment override", async () => {
		const executor = await createMigrationExecutor(
			{ binding: "PRIMARY_DB", connectionStringEnv: CONNECTION_ENV },
			{
				projectRoot: "/project",
				env: { OVERRIDE_DATABASE_URL: "postgres://user:secret@override.example.com/cms" },
				overrides: { databaseUrlEnv: "OVERRIDE_DATABASE_URL" },
			},
		);

		expect(executor.target.label).toBe("override.example.com:5432/cms");
	});

	it("rejects a non-PostgreSQL direct origin", async () => {
		await expect(
			createMigrationExecutor(
				{ binding: "PRIMARY_DB", connectionStringEnv: CONNECTION_ENV },
				{
					projectRoot: "/project",
					env: { [CONNECTION_ENV]: "mysql://user:secret@db.example.com/content" },
				},
			),
		).rejects.toThrow(/PostgreSQL migration connection string is invalid/i);
	});
});
