import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroI18nInput } from "../i18n/normalize.js";
import { normalizeAstroI18n } from "../i18n/normalize.js";
import type { CoreMigrationIdentity } from "./identity.js";
import {
	getMigrationIntegrationMetadata,
	MIGRATION_CONFIG_SYMBOL,
} from "./integration-metadata.js";
import { buildMigrationManifest } from "./manifest-builder.js";
import type { MigrationManifestV1 } from "./manifest.js";

const ASTRO_CONFIG_FILENAMES = [
	"astro.config.mjs",
	"astro.config.js",
	"astro.config.ts",
	"astro.config.mts",
] as const;

interface EvaluatedAstroConfig {
	integrations?: unknown[];
	i18n?: AstroI18nInput | null;
}

export interface BuildMigrationManifestFromConfigOptions {
	projectRoot: string;
	configFile?: string;
}

export interface MigrationConfigLoaderDependencies {
	findConfigFile: (projectRoot: string, configFile?: string) => Promise<string>;
	loadConfig: (projectRoot: string, configFile: string) => Promise<unknown>;
	loadIdentity: (projectRoot: string) => Promise<CoreMigrationIdentity>;
}

export class MigrationConfigLoaderError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "MigrationConfigLoaderError";
	}
}

async function isAccessible(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function findAstroConfigFile(
	projectRoot: string,
	configFile?: string,
): Promise<string> {
	const root = resolve(projectRoot);
	if (configFile) {
		const explicitPath = isAbsolute(configFile) ? configFile : resolve(root, configFile);
		if (await isAccessible(explicitPath)) return explicitPath;
		throw new MigrationConfigLoaderError(`Astro config file not found: ${explicitPath}`);
	}

	for (const filename of ASTRO_CONFIG_FILENAMES) {
		const candidate = resolve(root, filename);
		if (await isAccessible(candidate)) return candidate;
	}

	throw new MigrationConfigLoaderError(`No Astro config file found in ${root}`);
}

function projectRequire(projectRoot: string) {
	return createRequire(resolve(projectRoot, "package.json"));
}

async function importModule(path: string): Promise<unknown> {
	return import(pathToFileURL(path).href);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function moduleExport(module: unknown, name: string): unknown {
	if (!isRecord(module)) return undefined;
	const direct = module[name];
	if (direct !== undefined) return direct;
	const defaultExport = module.default;
	return isRecord(defaultExport) ? defaultExport[name] : undefined;
}

function isCoreMigrationIdentity(value: unknown): value is CoreMigrationIdentity {
	return (
		isRecord(value) &&
		typeof value.emdashVersion === "string" &&
		Array.isArray(value.names) &&
		value.names.every((name) => typeof name === "string") &&
		typeof value.fingerprint === "string"
	);
}

async function loadProjectConfig(projectRoot: string, configFile: string): Promise<unknown> {
	let viteEntrypoint: string;
	try {
		const require = projectRequire(projectRoot);
		const astroEntrypoint = require.resolve("astro");
		viteEntrypoint = createRequire(astroEntrypoint).resolve("vite");
	} catch (error) {
		throw new MigrationConfigLoaderError(
			"Could not resolve Vite through the project's Astro installation",
			{ cause: error },
		);
	}

	const vite = await importModule(viteEntrypoint);
	const loadConfigFromFile = moduleExport(vite, "loadConfigFromFile");
	if (typeof loadConfigFromFile !== "function") {
		throw new MigrationConfigLoaderError(
			"The Vite installation used by project-local Astro does not export loadConfigFromFile",
		);
	}
	const loaded: unknown = await Reflect.apply(loadConfigFromFile, undefined, [
		{ command: "build", mode: "production" },
		configFile,
		projectRoot,
		"silent",
	]);
	if (!isRecord(loaded) || !Object.hasOwn(loaded, "config")) {
		throw new MigrationConfigLoaderError(`Vite could not load Astro config: ${configFile}`);
	}
	return loaded.config;
}

async function loadProjectIdentity(projectRoot: string): Promise<CoreMigrationIdentity> {
	let identityEntrypoint: string;
	try {
		identityEntrypoint = projectRequire(projectRoot).resolve("emdash/migrations");
	} catch (error) {
		throw new MigrationConfigLoaderError("Could not resolve emdash/migrations from the project", {
			cause: error,
		});
	}

	const module = await importModule(identityEntrypoint);
	const getIdentity = moduleExport(module, "getCoreMigrationIdentity");
	if (typeof getIdentity !== "function") {
		throw new MigrationConfigLoaderError(
			"The project-local emdash/migrations module does not export getCoreMigrationIdentity",
		);
	}
	const identity: unknown = await Reflect.apply(getIdentity, undefined, []);
	if (!isCoreMigrationIdentity(identity)) {
		throw new MigrationConfigLoaderError(
			"The project-local emdash/migrations module returned an invalid migration identity",
		);
	}
	return identity;
}

const defaultDependencies: MigrationConfigLoaderDependencies = {
	findConfigFile: findAstroConfigFile,
	loadConfig: loadProjectConfig,
	loadIdentity: loadProjectIdentity,
};

function asAstroConfig(value: unknown): EvaluatedAstroConfig {
	if (typeof value !== "object" || value === null) {
		throw new MigrationConfigLoaderError("Astro config must export an object");
	}
	return value;
}

export async function buildMigrationManifestFromConfig(
	options: BuildMigrationManifestFromConfigOptions,
	dependencies: MigrationConfigLoaderDependencies = defaultDependencies,
): Promise<MigrationManifestV1> {
	const projectRoot = resolve(options.projectRoot);
	const configFile = await dependencies.findConfigFile(projectRoot, options.configFile);
	const config = asAstroConfig(await dependencies.loadConfig(projectRoot, configFile));
	const integrations = Array.isArray(config.integrations) ? config.integrations : [];
	const matchingIntegrations = integrations.filter(
		(integration) => getMigrationIntegrationMetadata(integration) !== undefined,
	);
	if (matchingIntegrations.length !== 1) {
		throw new MigrationConfigLoaderError(
			`Expected exactly one EmDash integration with migration metadata (${String(MIGRATION_CONFIG_SYMBOL)}), found ${matchingIntegrations.length}`,
		);
	}

	const metadata = getMigrationIntegrationMetadata(matchingIntegrations[0]);
	if (!metadata?.database) {
		throw new MigrationConfigLoaderError(
			"The EmDash integration does not provide database migration metadata",
		);
	}
	const identity = await dependencies.loadIdentity(projectRoot);

	return buildMigrationManifest({
		identity,
		i18n: normalizeAstroI18n(config.i18n),
		database: metadata.database,
	});
}
