import { describe, expect, it } from "vitest";

import { libsql, postgres, sqlite } from "../../../src/db/adapters.js";

describe("database adapter migration descriptors", () => {
	it("opts SQLite into migrations with an explicit secret-free config copy", () => {
		const config = { url: "file:./data.db" };
		const descriptor = sqlite(config);

		expect(descriptor).toEqual({
			entrypoint: "emdash/db/sqlite",
			config: { url: "file:./data.db" },
			type: "sqlite",
			migrations: {
				entrypoint: "emdash/db/sqlite-migrations",
				manifestConfig: { url: "file:./data.db" },
			},
		});
		expect(descriptor.config).toBe(config);
		expect(descriptor.migrations?.manifestConfig).not.toBe(descriptor.config);
	});

	it("keeps the libSQL runtime token out of migration metadata", () => {
		const descriptor = libsql({
			url: "libsql://example.turso.io",
			authToken: "runtime-secret",
			migrationAuthTokenEnv: "DEPLOY_TURSO_TOKEN",
		});

		expect(descriptor.config).toEqual({
			url: "libsql://example.turso.io",
			authToken: "runtime-secret",
		});
		expect(descriptor.migrations).toEqual({
			entrypoint: "emdash/db/libsql-migrations",
			manifestConfig: {
				url: "libsql://example.turso.io",
				authTokenEnv: "DEPLOY_TURSO_TOKEN",
			},
		});
		expect(JSON.stringify(descriptor.migrations)).not.toContain("runtime-secret");
	});

	it("defaults the libSQL migration token variable without changing runtime config", () => {
		const descriptor = libsql({ url: "libsql://example.turso.io" });

		expect(descriptor.config).toEqual({ url: "libsql://example.turso.io" });
		expect(descriptor.migrations?.manifestConfig).toEqual({
			url: "libsql://example.turso.io",
			authTokenEnv: "TURSO_AUTH_TOKEN",
		});
	});

	it("rejects an invalid libSQL migration environment variable name", () => {
		expect(() =>
			libsql({
				url: "libsql://example.turso.io",
				migrationAuthTokenEnv: "not valid",
			}),
		).toThrow(/migrationAuthTokenEnv/);
	});

	it("keeps PostgreSQL runtime credentials out of migration metadata", () => {
		const descriptor = postgres({
			connectionString: "postgres://runtime:secret@example.com/site?sslmode=require",
			pool: { min: 2, max: 20 },
			migrationConnectionStringEnv: "DEPLOY_DATABASE_URL",
		});

		expect(descriptor.config).toEqual({
			connectionString: "postgres://runtime:secret@example.com/site?sslmode=require",
			pool: { min: 2, max: 20 },
		});
		expect(descriptor.migrations).toEqual({
			entrypoint: "emdash/db/postgres-migrations",
			manifestConfig: { connectionStringEnv: "DEPLOY_DATABASE_URL" },
		});
		expect(JSON.stringify(descriptor.migrations)).not.toContain("runtime:secret");
	});

	it("defaults the PostgreSQL migration connection variable to DATABASE_URL", () => {
		const descriptor = postgres({ host: "runtime-host", password: "runtime-secret" });

		expect(descriptor.config).toEqual({ host: "runtime-host", password: "runtime-secret" });
		expect(descriptor.migrations?.manifestConfig).toEqual({
			connectionStringEnv: "DATABASE_URL",
		});
	});

	it("rejects an invalid PostgreSQL migration environment variable name", () => {
		expect(() => postgres({ migrationConnectionStringEnv: "" })).toThrow(
			/migrationConnectionStringEnv/,
		);
	});
});
