import { describe, it, expect } from "vitest";

import { hyperdrive } from "../src/index.js";

describe("hyperdrive()", () => {
	it("returns a postgres DatabaseDescriptor with the hyperdrive entrypoint", () => {
		const result = hyperdrive({ binding: "HYPERDRIVE" });
		expect(result).toEqual({
			entrypoint: "@emdash-cms/cloudflare/db/hyperdrive",
			config: { binding: "HYPERDRIVE", max: undefined },
			type: "postgres",
			migrations: {
				entrypoint: "@emdash-cms/cloudflare/db/hyperdrive-migrations",
				manifestConfig: {
					binding: "HYPERDRIVE",
					connectionStringEnv: "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
				},
			},
			supportsRequestScope: true,
		});
	});

	it("defaults the binding to HYPERDRIVE", () => {
		const result = hyperdrive();
		expect(result.config).toEqual({ binding: "HYPERDRIVE", max: undefined });
		expect(result.type).toBe("postgres");
	});

	it("passes through a custom binding and pool max", () => {
		const result = hyperdrive({ binding: "PG", max: 10 });
		expect(result.config).toEqual({ binding: "PG", max: 10 });
	});

	it("requests request-scoped db support (per-request pg connections)", () => {
		const result = hyperdrive();
		expect(result.supportsRequestScope).toBe(true);
	});

	it("omits cachedBinding from the descriptor when not provided", () => {
		const result = hyperdrive({ binding: "HYPERDRIVE" });
		expect(result.config).not.toHaveProperty("cachedBinding");
	});

	it("passes through a cachedBinding for split caching", () => {
		const result = hyperdrive({ binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" });
		expect(result.config).toEqual({
			binding: "HYPERDRIVE",
			max: undefined,
			cachedBinding: "HYPERDRIVE_CACHED",
		});
	});

	it("keeps migration credentials out of runtime config and never selects the cached binding", () => {
		const result = hyperdrive({
			binding: "PRIMARY_DB",
			cachedBinding: "CACHED_DB",
			migrationConnectionStringEnv: "DEPLOYMENT_DATABASE_URL",
		});

		expect(result.config).not.toHaveProperty("migrationConnectionStringEnv");
		expect(result.migrations).toEqual({
			entrypoint: "@emdash-cms/cloudflare/db/hyperdrive-migrations",
			manifestConfig: {
				binding: "PRIMARY_DB",
				connectionStringEnv: "DEPLOYMENT_DATABASE_URL",
			},
		});
		expect(JSON.stringify(result.migrations)).not.toContain("CACHED_DB");
	});

	it("derives the default direct-origin environment variable from the primary binding", () => {
		const result = hyperdrive({ binding: "CONTENT_DB" });

		expect(result.migrations?.manifestConfig).toEqual({
			binding: "CONTENT_DB",
			connectionStringEnv: "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CONTENT_DB",
		});
	});

	it("keeps JavaScript bindings containing dollar signs backwards compatible", () => {
		const result = hyperdrive({ binding: "$CONTENT_DB" });

		expect(result.config).toMatchObject({ binding: "$CONTENT_DB" });
		expect(result.migrations?.manifestConfig).toEqual({
			binding: "$CONTENT_DB",
			connectionStringEnv: "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING__CONTENT_DB",
		});
	});

	it("rejects an invalid migration environment variable name", () => {
		expect(() => hyperdrive({ migrationConnectionStringEnv: "DEPLOYMENT-DATABASE-URL" })).toThrow(
			/valid environment variable name/i,
		);
	});
});
