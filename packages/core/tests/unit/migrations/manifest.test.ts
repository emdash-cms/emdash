import { describe, expect, it } from "vitest";

import { createCoreMigrationIdentity } from "../../../src/migrations/identity.js";
import {
	buildMigrationManifest,
	UnsupportedMigrationAdapterError,
} from "../../../src/migrations/manifest-builder.js";
import {
	MigrationManifestValidationError,
	validateMigrationManifest,
} from "../../../src/migrations/manifest.js";

async function fixture() {
	const identity = await createCoreMigrationIdentity("1.2.3", ["001_initial", "002_media"]);
	const database = {
		type: "sqlite" as const,
		entrypoint: "emdash/db/sqlite",
		config: { url: "file:./runtime.db", authToken: "runtime-only-secret" },
		migrations: {
			entrypoint: "emdash/db/sqlite-migrations",
			manifestConfig: { url: "file:./data.db" },
		},
	};
	const i18n = {
		defaultLocale: "fr",
		locales: ["en", "fr"],
		fallback: { fr: "en" },
		prefixDefaultLocale: true,
	};
	const manifest = await buildMigrationManifest({ identity, i18n, database });
	return { database, i18n, identity, manifest };
}

describe("buildMigrationManifest", () => {
	it("builds the versioned manifest from explicit migration metadata", async () => {
		const { manifest } = await fixture();

		expect(manifest).toMatchObject({
			schemaVersion: 1,
			emdashVersion: "1.2.3",
			migrationSet: {
				names: ["001_initial", "002_media"],
			},
			i18n: {
				defaultLocale: "fr",
				locales: ["en", "fr"],
			},
			database: {
				type: "sqlite",
				executorEntrypoint: "emdash/db/sqlite-migrations",
				executorConfig: { url: "file:./data.db" },
			},
		});
		expect(JSON.stringify(manifest)).not.toContain("runtime-only-secret");
	});

	it("never falls back to runtime database configuration", async () => {
		const identity = await createCoreMigrationIdentity("1.2.3", ["001_initial"]);
		const database = {
			type: "postgres" as const,
			entrypoint: "emdash/db/postgres",
			config: { connectionString: "postgres://user:password@example.com/db" },
		};

		await expect(buildMigrationManifest({ identity, i18n: null, database })).rejects.toBeInstanceOf(
			UnsupportedMigrationAdapterError,
		);
	});

	it("rejects a malformed identity instead of emitting it", async () => {
		const { database, identity } = await fixture();

		await expect(
			buildMigrationManifest({
				identity: { ...identity, fingerprint: "0".repeat(64) },
				i18n: null,
				database,
			}),
		).rejects.toThrow("identity fingerprint");
	});
});

describe("validateMigrationManifest", () => {
	it("rejects unsupported schema versions", async () => {
		const { manifest } = await fixture();

		await expect(
			validateMigrationManifest({ ...manifest, schemaVersion: 2 }),
		).rejects.toBeInstanceOf(MigrationManifestValidationError);
	});

	it("rejects stale versions and migration sets", async () => {
		const { manifest } = await fixture();
		const newerIdentity = await createCoreMigrationIdentity("1.3.0", [
			"001_initial",
			"002_media",
			"003_new",
		]);

		await expect(validateMigrationManifest(manifest, newerIdentity)).rejects.toThrow(
			"does not match the loaded EmDash migration identity",
		);
	});

	it.each([
		"../executor.js",
		"/tmp/executor.js",
		"file:///tmp/executor.js",
		"data:text/javascript,x",
	])("rejects unsafe executor entrypoint %s", async (executorEntrypoint) => {
		const { manifest } = await fixture();

		await expect(
			validateMigrationManifest({
				...manifest,
				database: { ...manifest.database, executorEntrypoint },
			}),
		).rejects.toThrow("schema validation failed");
	});

	it.each([
		"postgres://user:password@db.example.com/site",
		{ authToken: "top-secret-token" },
		{ connectionString: "postgres://db.example.com/site" },
		{ url: "libsql://user:password@db.example.com" },
		{ url: "https://db.example.com?token=top-secret-token" },
	])("rejects secret-bearing executor configuration", async (executorConfig) => {
		const { manifest } = await fixture();

		await expect(
			validateMigrationManifest({
				...manifest,
				database: { ...manifest.database, executorConfig },
			}),
		).rejects.toBeInstanceOf(MigrationManifestValidationError);
	});

	it("does not include rejected credential values in errors", async () => {
		const { manifest } = await fixture();
		const credential = "must-not-appear-in-errors";

		await expect(
			validateMigrationManifest({
				...manifest,
				database: {
					...manifest.database,
					executorConfig: { url: `libsql://user:${credential}@db.example.com` },
				},
			}),
		).rejects.not.toThrow(credential);
	});

	it("accepts environment-variable names without resolving their values", async () => {
		const { manifest } = await fixture();
		const executorConfig = {
			url: "libsql://public-db.example.com",
			authTokenEnv: "TURSO_AUTH_TOKEN",
			connectionStringEnv: "DATABASE_URL",
		};

		await expect(
			validateMigrationManifest({
				...manifest,
				database: { ...manifest.database, executorConfig },
			}),
		).resolves.toMatchObject({ database: { executorConfig } });
	});
});
