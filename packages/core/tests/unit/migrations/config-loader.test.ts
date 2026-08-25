import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatabaseDescriptor } from "../../../src/db/adapters.js";
import {
	buildMigrationManifestFromConfig,
	findAstroConfigFile,
} from "../../../src/migrations/config-loader.js";
import { createCoreMigrationIdentity } from "../../../src/migrations/identity.js";
import {
	createMigrationIntegrationMetadata,
	MIGRATION_CONFIG_SYMBOL,
} from "../../../src/migrations/integration-metadata.js";

const sqliteDatabase: DatabaseDescriptor = {
	type: "sqlite",
	entrypoint: "emdash/db/sqlite",
	config: { secret: "runtime only" },
	migrations: {
		entrypoint: "emdash/db/sqlite-migrations",
		manifestConfig: { url: "file:./data.db" },
	},
};

describe("migration integration metadata", () => {
	it("copies only deployment-safe database fields", () => {
		const metadata = createMigrationIntegrationMetadata(sqliteDatabase);

		expect(metadata).toEqual({
			database: {
				type: "sqlite",
				migrations: {
					entrypoint: "emdash/db/sqlite-migrations",
					manifestConfig: { url: "file:./data.db" },
				},
			},
		});
		expect(metadata.database).not.toHaveProperty("entrypoint");
		expect(metadata.database).not.toHaveProperty("config");
	});

	it("rejects credential-bearing manifest configuration before attaching metadata", () => {
		expect(() =>
			createMigrationIntegrationMetadata({
				...sqliteDatabase,
				migrations: {
					entrypoint: "emdash/db/sqlite-migrations",
					manifestConfig: { password: "do-not-attach" },
				},
			}),
		).toThrow("database.migrations.manifestConfig.password is a credential-bearing field");
	});
});

describe("findAstroConfigFile", () => {
	const tempDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
		);
	});

	it("discovers Astro config using Astro's filename precedence", async () => {
		const root = await mkdtemp(join(tmpdir(), "emdash-config-discovery-"));
		tempDirectories.push(root);
		await writeFile(join(root, "astro.config.ts"), "export default {};");
		await writeFile(join(root, "astro.config.mjs"), "export default {};");

		await expect(findAstroConfigFile(root)).resolves.toBe(join(root, "astro.config.mjs"));
	});

	it("accepts an explicit config path relative to the project root", async () => {
		const root = await mkdtemp(join(tmpdir(), "emdash-config-explicit-"));
		tempDirectories.push(root);
		await mkdir(join(root, "config"));
		await writeFile(join(root, "config", "astro.mjs"), "export default {};");

		await expect(findAstroConfigFile(root, "config/astro.mjs")).resolves.toBe(
			join(root, "config", "astro.mjs"),
		);
	});
});

describe("buildMigrationManifestFromConfig", () => {
	const identityPromise = createCoreMigrationIdentity("1.2.3", ["001_initial"]);

	it("evaluates explicit config, reads one metadata integration, and normalizes i18n", async () => {
		const root = "/project";
		const configFile = "/project/custom.astro.config.mjs";
		const integration = {
			name: "emdash",
			hooks: { "astro:config:setup": vi.fn(() => Promise.reject(new Error("hook ran"))) },
			[MIGRATION_CONFIG_SYMBOL]: createMigrationIntegrationMetadata(sqliteDatabase),
		};
		const loadConfig = vi.fn(async () => ({
			integrations: [integration],
			i18n: {
				defaultLocale: "en",
				locales: ["en", { path: "fr", codes: ["fr-FR"] }],
				fallback: { fr: "en", de: undefined },
				routing: { prefixDefaultLocale: true },
			},
		}));

		const manifest = await buildMigrationManifestFromConfig(
			{ projectRoot: root, configFile },
			{
				findConfigFile: vi.fn(async () => configFile),
				loadConfig,
				loadIdentity: vi.fn(async () => identityPromise),
			},
		);

		expect(loadConfig).toHaveBeenCalledOnce();
		expect(integration.hooks["astro:config:setup"]).not.toHaveBeenCalled();
		expect(manifest.i18n).toEqual({
			defaultLocale: "en",
			locales: ["en", "fr"],
			fallback: { fr: "en" },
			prefixDefaultLocale: true,
		});
		expect(manifest.database).toEqual({
			type: "sqlite",
			executorEntrypoint: "emdash/db/sqlite-migrations",
			executorConfig: { url: "file:./data.db" },
		});
	});

	it.each([
		["no", []],
		[
			"multiple",
			[
				{ [MIGRATION_CONFIG_SYMBOL]: createMigrationIntegrationMetadata(sqliteDatabase) },
				{ [MIGRATION_CONFIG_SYMBOL]: createMigrationIntegrationMetadata(sqliteDatabase) },
			],
		],
	])("rejects config with %s metadata integrations", async (_, integrations) => {
		await expect(
			buildMigrationManifestFromConfig(
				{ projectRoot: "/project" },
				{
					findConfigFile: vi.fn(async () => "/project/astro.config.mjs"),
					loadConfig: vi.fn(async () => ({ integrations })),
					loadIdentity: vi.fn(async () => identityPromise),
				},
			),
		).rejects.toThrow(`Expected exactly one EmDash integration with migration metadata`);
	});
});

describe("project-local package resolution", () => {
	const tempDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
		);
	});

	async function writeModule(path: string, contents: string): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, contents);
	}

	it("loads Vite through project Astro and identity through project EmDash under pnpm links", async () => {
		const root = await mkdtemp(join(tmpdir(), "emdash-project-resolution-"));
		tempDirectories.push(root);
		const modules = join(root, "node_modules");
		const astroPackage = join(modules, ".pnpm", "astro@local", "node_modules", "astro");
		const astroModules = join(modules, ".pnpm", "astro@local", "node_modules");
		const vitePackage = join(modules, ".pnpm", "vite@local", "node_modules", "vite");
		const emdashPackage = join(modules, ".pnpm", "emdash@local", "node_modules", "emdash");
		const identity = await createCoreMigrationIdentity("9.8.7-project", ["001_project"]);
		await writeFile(join(root, "package.json"), '{"type":"module"}');
		await writeModule(
			join(astroPackage, "package.json"),
			'{"name":"astro","type":"module","exports":"./index.js"}',
		);
		await writeModule(join(astroPackage, "index.js"), "export {};\n");
		await writeModule(
			join(vitePackage, "package.json"),
			'{"name":"vite","type":"module","exports":"./index.js"}',
		);
		await writeModule(
			join(vitePackage, "index.js"),
			`import { pathToFileURL } from "node:url";
			export async function loadConfigFromFile(_env, configFile) {
				const loaded = await import(pathToFileURL(configFile).href);
				return { path: configFile, config: loaded.default, dependencies: [] };
			}`,
		);
		await writeModule(
			join(emdashPackage, "package.json"),
			'{"name":"emdash","type":"module","exports":{"./migrations":"./migrations.js"}}',
		);
		await writeModule(
			join(emdashPackage, "migrations.js"),
			`export async function getCoreMigrationIdentity() { return ${JSON.stringify(identity)}; }`,
		);
		await mkdir(modules, { recursive: true });
		await symlink(astroPackage, join(modules, "astro"), "dir");
		await symlink(vitePackage, join(astroModules, "vite"), "dir");
		await symlink(emdashPackage, join(modules, "emdash"), "dir");
		await writeFile(
			join(root, "astro.config.mjs"),
			`export default {
				integrations: [{
					[Symbol.for("emdash:migration-config")]: {
						database: {
							type: "sqlite",
							migrations: {
								entrypoint: "emdash/db/sqlite-migrations",
								manifestConfig: { url: "file:./project.db" }
							}
						}
					}
				}],
				i18n: { defaultLocale: "en", locales: ["en"] }
			};`,
		);

		const manifest = await buildMigrationManifestFromConfig({ projectRoot: root });

		expect(manifest.emdashVersion).toBe("9.8.7-project");
		expect(manifest.migrationSet.names).toEqual(["001_project"]);
		expect(manifest.database.executorConfig).toEqual({ url: "file:./project.db" });
	});
});
