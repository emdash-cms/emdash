import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroIntegration } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emdash } from "../../../../src/astro/integration/index.js";
import { libsql } from "../../../../src/db/adapters.js";
import { MIGRATION_MANIFEST_PATH } from "../../../../src/migrations/manifest-writer.js";

const MIGRATION_CONFIG_SYMBOL = Symbol.for("emdash:migration-config");

function hook(integration: AstroIntegration, name: "astro:config:setup" | "astro:config:done") {
	const handler = integration.hooks[name];
	if (typeof handler !== "function") throw new Error(`Missing ${name} hook`);
	return handler;
}

describe("migration manifest integration", () => {
	const projectRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			projectRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
		);
	});

	async function runHooks(
		command: "dev" | "build" | "preview" | "sync",
		integration: AstroIntegration,
	) {
		const projectRoot = await mkdtemp(join(tmpdir(), `emdash-manifest-${command}-`));
		projectRoots.push(projectRoot);
		const root = pathToFileURL(`${projectRoot}/`);
		const logger = {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		};
		const astroConfig = {
			root,
			srcDir: new URL("src/", root),
			security: {},
			trailingSlash: "ignore",
			integrations: [{ name: "@astrojs/react", hooks: {} }],
			i18n: {
				defaultLocale: "english",
				locales: [
					{ path: "english", codes: ["en", "en-US"] },
					{ path: "french", codes: ["fr", "fr-FR"] },
				],
				fallback: { french: "english" },
				routing: { prefixDefaultLocale: true },
			},
		};

		await hook(
			integration,
			"astro:config:setup",
		)({
			command,
			config: astroConfig,
			logger,
			injectRoute: vi.fn(),
			addMiddleware: vi.fn(),
			updateConfig: vi.fn(),
		} as never);
		await hook(
			integration,
			"astro:config:done",
		)({
			config: astroConfig,
			logger,
		} as never);

		return {
			logger,
			manifestPath: join(projectRoot, MIGRATION_MANIFEST_PATH),
			projectRoot,
		};
	}

	it("writes equivalent secret-free manifests under each build and sync project root", async () => {
		const database = libsql({
			url: "libsql://public-db.example.com",
			authToken: "runtime-only-secret",
		});
		const build = await runHooks("build", emdash({ database }));
		const sync = await runHooks("sync", emdash({ database }));
		const buildOutput = await readFile(build.manifestPath, "utf8");
		const syncOutput = await readFile(sync.manifestPath, "utf8");

		expect(syncOutput).toBe(buildOutput);
		expect(build.manifestPath).toBe(join(build.projectRoot, ".emdash", "migrations.json"));
		expect(buildOutput).not.toContain("runtime-only-secret");
		expect(JSON.parse(buildOutput)).toMatchObject({
			i18n: {
				defaultLocale: "english",
				locales: ["english", "french"],
				fallback: { french: "english" },
				prefixDefaultLocale: true,
			},
			database: {
				type: "sqlite",
				executorEntrypoint: "emdash/db/libsql-migrations",
				executorConfig: {
					url: "libsql://public-db.example.com",
					authTokenEnv: "TURSO_AUTH_TOKEN",
				},
			},
		});
	});

	it.each(["dev", "preview"] as const)("does not write a manifest during %s", async (command) => {
		const { manifestPath } = await runHooks(
			command,
			emdash({ database: libsql({ url: "libsql://public-db.example.com" }) }),
		);

		await expect(readFile(manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([
		["missing", undefined],
		[
			"unsupported",
			{
				type: "sqlite" as const,
				entrypoint: "example/runtime",
				config: { token: "runtime-only-secret" },
			},
		],
	] as const)("warns and skips a %s database adapter", async (_kind, database) => {
		const { logger, manifestPath } = await runHooks("build", emdash({ database }));

		await expect(readFile(manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("migration manifest"));
	});

	it("attaches only secret-free migration metadata to the integration", () => {
		const integration = emdash({
			database: libsql({
				url: "libsql://public-db.example.com",
				authToken: "runtime-only-secret",
			}),
		});
		const metadata = (integration as unknown as Record<symbol, unknown>)[MIGRATION_CONFIG_SYMBOL];
		const serialized = JSON.stringify(metadata);

		expect(serialized).not.toContain("runtime-only-secret");
		expect(metadata).toEqual({
			database: {
				type: "sqlite",
				migrations: {
					entrypoint: "emdash/db/libsql-migrations",
					manifestConfig: {
						url: "libsql://public-db.example.com",
						authTokenEnv: "TURSO_AUTH_TOKEN",
					},
				},
			},
		});
	});
});
