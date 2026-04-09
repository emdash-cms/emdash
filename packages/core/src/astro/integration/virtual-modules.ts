/**
 * Virtual Module Generators
 *
 * Functions that generate virtual module content for Vite.
 * These modules statically import configured dependencies
 * so Vite can properly resolve and bundle them.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { AuthProviderDescriptor } from "../../auth/types.js";
import type { MediaProviderDescriptor } from "../../media/types.js";
import { defaultSeed } from "../../seed/default.js";
import type { PluginDescriptor } from "./runtime.js";

const TS_SOURCE_EXT_RE = /^\.(ts|tsx|mts|cts|jsx)$/;

/** Pattern to remove scoped package prefix from plugin ID */
const SCOPED_PREFIX_PATTERN = /^@[^/]+\/plugin-/;

/** Pattern to remove emdash-plugin- prefix from plugin ID */
const EMDASH_PREFIX_PATTERN = /^emdash-plugin-/;

// Virtual module IDs
export const VIRTUAL_CONFIG_ID = "virtual:emdash/config";
export const RESOLVED_VIRTUAL_CONFIG_ID = "\0" + VIRTUAL_CONFIG_ID;

export const VIRTUAL_DIALECT_ID = "virtual:emdash/dialect";
export const RESOLVED_VIRTUAL_DIALECT_ID = "\0" + VIRTUAL_DIALECT_ID;

export const VIRTUAL_STORAGE_ID = "virtual:emdash/storage";
export const RESOLVED_VIRTUAL_STORAGE_ID = "\0" + VIRTUAL_STORAGE_ID;

export const VIRTUAL_ADMIN_REGISTRY_ID = "virtual:emdash/admin-registry";
export const RESOLVED_VIRTUAL_ADMIN_REGISTRY_ID = "\0" + VIRTUAL_ADMIN_REGISTRY_ID;

export const VIRTUAL_PLUGINS_ID = "virtual:emdash/plugins";
export const RESOLVED_VIRTUAL_PLUGINS_ID = "\0" + VIRTUAL_PLUGINS_ID;

export const VIRTUAL_SANDBOX_RUNNER_ID = "virtual:emdash/sandbox-runner";
export const RESOLVED_VIRTUAL_SANDBOX_RUNNER_ID = "\0" + VIRTUAL_SANDBOX_RUNNER_ID;

export const VIRTUAL_SANDBOXED_PLUGINS_ID = "virtual:emdash/sandboxed-plugins";
export const RESOLVED_VIRTUAL_SANDBOXED_PLUGINS_ID = "\0" + VIRTUAL_SANDBOXED_PLUGINS_ID;

export const VIRTUAL_AUTH_ID = "virtual:emdash/auth";
export const RESOLVED_VIRTUAL_AUTH_ID = "\0" + VIRTUAL_AUTH_ID;

export const VIRTUAL_AUTH_PROVIDERS_ID = "virtual:emdash/auth-providers";
export const RESOLVED_VIRTUAL_AUTH_PROVIDERS_ID = "\0" + VIRTUAL_AUTH_PROVIDERS_ID;

export const VIRTUAL_MEDIA_PROVIDERS_ID = "virtual:emdash/media-providers";
export const RESOLVED_VIRTUAL_MEDIA_PROVIDERS_ID = "\0" + VIRTUAL_MEDIA_PROVIDERS_ID;

export const VIRTUAL_BLOCK_COMPONENTS_ID = "virtual:emdash/block-components";
export const RESOLVED_VIRTUAL_BLOCK_COMPONENTS_ID = "\0" + VIRTUAL_BLOCK_COMPONENTS_ID;

export const VIRTUAL_SEED_ID = "virtual:emdash/seed";
export const RESOLVED_VIRTUAL_SEED_ID = "\0" + VIRTUAL_SEED_ID;

/**
 * Generates the config virtual module.
 */
export function generateConfigModule(serializableConfig: Record<string, unknown>): string {
	return `export default ${JSON.stringify(serializableConfig)};`;
}

/**
 * Generates the dialect virtual module.
 * Statically imports the configured database dialect and exports the dialect type.
 *
 * For D1 adapters, also re-exports session helpers (isSessionEnabled, getD1Binding,
 * getDefaultConstraint, getBookmarkCookieName, createSessionDialect) used by
 * middleware for per-request read replica sessions.
 *
 * For non-D1 adapters, session exports are no-ops.
 */
export function generateDialectModule(
	dbEntrypoint?: string,
	dbType?: string,
	dbConfig?: unknown,
): string {
	if (!dbEntrypoint) {
		return [
			`export const createDialect = undefined;`,
			`export const dialectType = "sqlite";`,
			`export const isSessionEnabled = () => false;`,
			`export const getD1Binding = () => null;`,
			`export const getDefaultConstraint = () => "first-unconstrained";`,
			`export const getBookmarkCookieName = () => "";`,
			`export const createSessionDialect = undefined;`,
		].join("\n");
	}
	const type = dbType ?? "sqlite";

	// Check if the adapter is D1 (has session helpers)
	const isD1 = dbEntrypoint.includes("cloudflare") && dbEntrypoint.includes("d1");

	// Check if sessions are enabled in the config
	const sessionMode =
		isD1 && dbConfig && typeof dbConfig === "object" && "session" in dbConfig
			? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- runtime-checked above
				(dbConfig as { session?: string }).session
			: undefined;
	const sessionEnabled = !!sessionMode && sessionMode !== "disabled";

	if (isD1 && sessionEnabled) {
		return `
import { createDialect as _createDialect } from "${dbEntrypoint}";
export { isSessionEnabled, getD1Binding, getDefaultConstraint, getBookmarkCookieName, createSessionDialect } from "${dbEntrypoint}";
export const createDialect = _createDialect;
export const dialectType = ${JSON.stringify(type)};
`;
	}

	// Non-D1 or sessions disabled: export no-ops
	return `
import { createDialect as _createDialect } from "${dbEntrypoint}";
export const createDialect = _createDialect;
export const dialectType = ${JSON.stringify(type)};
export const isSessionEnabled = () => false;
export const getD1Binding = () => null;
export const getDefaultConstraint = () => "first-unconstrained";
export const getBookmarkCookieName = () => "";
export const createSessionDialect = undefined;
`;
}

/**
 * Generates the storage virtual module.
 * Statically imports the configured storage adapter.
 */
export function generateStorageModule(storageEntrypoint?: string): string {
	if (!storageEntrypoint) {
		return `export const createStorage = undefined;`;
	}
	return `
import { createStorage as _createStorage } from "${storageEntrypoint}";
export const createStorage = _createStorage;
`;
}

/**
 * Generates the auth virtual module.
 * Statically imports the configured auth provider.
 */
export function generateAuthModule(authEntrypoint?: string): string {
	if (!authEntrypoint) {
		return `export const authenticate = undefined;`;
	}
	return `
import { authenticate as _authenticate } from "${authEntrypoint}";
export const authenticate = _authenticate;
`;
}

/**
 * Generates the auth providers module.
 *
 * Statically imports each auth provider's `adminEntry` module and exports
 * a registry keyed by provider ID. The admin UI uses this to render
 * provider-specific login buttons/forms and setup steps.
 *
 * Follows the same pattern as `generateAdminRegistryModule()` for plugins.
 */
export function generateAuthProvidersModule(descriptors: AuthProviderDescriptor[]): string {
	const withAdmin = descriptors.filter((d) => d.adminEntry);

	if (withAdmin.length === 0) {
		return `export const authProviders = {};`;
	}

	const imports: string[] = [];
	const entries: string[] = [];

	withAdmin.forEach((descriptor, index) => {
		const varName = `authProvider${index}`;
		imports.push(`import * as ${varName} from ${JSON.stringify(descriptor.adminEntry)};`);
		entries.push(
			`  ${JSON.stringify(descriptor.id)}: { ...${varName}, id: ${JSON.stringify(descriptor.id)}, label: ${JSON.stringify(descriptor.label)} },`,
		);
	});

	return `
// Auto-generated auth provider registry
${imports.join("\n")}

export const authProviders = {
${entries.join("\n")}
};
`;
}

/**
 * Generates the plugins module.
 * Imports and instantiates all plugins at runtime.
 *
 * Handles two plugin formats:
 * - **Native**: imports `createPlugin` and calls it with options
 * - **Standard**: imports the default export and wraps it with `adaptSandboxEntry`
 *
 * The format is determined by `descriptor.format`:
 * - `"standard"` -- uses adaptSandboxEntry
 * - `"native"` or undefined -- uses createPlugin
 *
 * This is critical for Cloudflare Workers where globals don't persist
 * between build time and runtime.
 */
export function generatePluginsModule(descriptors: PluginDescriptor[]): string {
	if (descriptors.length === 0) {
		return `export const plugins = [];`;
	}

	const imports: string[] = [];
	const instantiations: string[] = [];

	// Track whether we need the adapter import
	let needsAdapter = false;

	descriptors.forEach((descriptor, index) => {
		if (descriptor.format === "standard") {
			// Standard format: import default export, wrap with adaptSandboxEntry
			needsAdapter = true;
			const varName = `pluginDef${index}`;
			imports.push(`import ${varName} from "${descriptor.entrypoint}";`);
			instantiations.push(
				`adaptSandboxEntry(${varName}, ${JSON.stringify({
					id: descriptor.id,
					version: descriptor.version,
					capabilities: descriptor.capabilities,
					allowedHosts: descriptor.allowedHosts,
					storage: descriptor.storage,
					adminPages: descriptor.adminPages,
					adminWidgets: descriptor.adminWidgets,
				})})`,
			);
		} else {
			// Native format: import createPlugin and call with options
			const varName = `createPlugin${index}`;
			imports.push(`import { createPlugin as ${varName} } from "${descriptor.entrypoint}";`);
			instantiations.push(`${varName}(${JSON.stringify(descriptor.options ?? {})})`);
		}
	});

	const adapterImport = needsAdapter
		? `import { adaptSandboxEntry } from "emdash/plugins/adapt-sandbox-entry";\n`
		: "";

	return `
// Auto-generated plugins module
// Imports and instantiates all configured plugins at runtime

${adapterImport}${imports.join("\n")}

/** Resolved plugins array */
export const plugins = [
  ${instantiations.join(",\n  ")}
];
`;
}

/**
 * Generates the admin registry module.
 * Uses adminEntry from plugin descriptors to statically import admin modules.
 */
export function generateAdminRegistryModule(descriptors: PluginDescriptor[]): string {
	// Filter to descriptors with admin entries
	const adminDescriptors = descriptors.filter((d) => d.adminEntry);

	if (adminDescriptors.length === 0) {
		return `export const pluginAdmins = {};`;
	}

	const imports: string[] = [];
	const entries: string[] = [];

	adminDescriptors.forEach((descriptor, index) => {
		const varName = `admin${index}`;
		// Use explicit ID from descriptor if available, otherwise derive from entrypoint
		const pluginId =
			descriptor.id ??
			descriptor.entrypoint.replace(SCOPED_PREFIX_PATTERN, "").replace(EMDASH_PREFIX_PATTERN, "");

		imports.push(`import * as ${varName} from "${descriptor.adminEntry}";`);
		entries.push(`  "${pluginId}": ${varName},`);
	});

	return `
// Auto-generated plugin admin registry
${imports.join("\n")}

export const pluginAdmins = {
${entries.join("\n")}
};
`;
}

/**
 * Generates the sandbox runner module.
 * Imports the configured sandbox runner factory or provides a noop default.
 */
export function generateSandboxRunnerModule(sandboxRunner?: string): string {
	if (!sandboxRunner) {
		// No sandbox runner configured - use noop
		return `
// No sandbox runner configured - sandboxed plugins disabled
import { createNoopSandboxRunner } from "emdash";

export const createSandboxRunner = createNoopSandboxRunner;
export const sandboxEnabled = false;
`;
	}

	return `
// Auto-generated sandbox runner module
import { createSandboxRunner as _createSandboxRunner } from "${sandboxRunner}";

export const createSandboxRunner = _createSandboxRunner;
export const sandboxEnabled = true;
`;
}

/**
 * Generates the media providers module.
 * Imports and instantiates configured media providers at runtime.
 */
export function generateMediaProvidersModule(descriptors: MediaProviderDescriptor[]): string {
	// Always include local provider by default unless explicitly disabled
	const localDisabled = descriptors.some((d) => d.id === "local" && d.config.enabled === false);

	const imports: string[] = [];
	const entries: string[] = [];

	// Add local provider first if not disabled
	if (!localDisabled) {
		imports.push(
			`import { createMediaProvider as createLocalProvider } from "emdash/media/local-runtime";`,
		);
		entries.push(`{
	id: "local",
	name: "Library",
	icon: "folder",
	capabilities: { browse: true, search: false, upload: true, delete: true },
	createProvider: (ctx) => createLocalProvider({ ...ctx, enabled: true }),
}`);
	}

	// Add custom providers
	descriptors
		.filter((d) => d.id !== "local" || d.config.enabled !== false)
		.filter((d) => d.id !== "local") // Skip local if we already added it
		.forEach((descriptor, index) => {
			const varName = `createProvider${index}`;
			imports.push(`import { createMediaProvider as ${varName} } from "${descriptor.entrypoint}";`);
			entries.push(`{
	id: ${JSON.stringify(descriptor.id)},
	name: ${JSON.stringify(descriptor.name)},
	icon: ${JSON.stringify(descriptor.icon)},
	capabilities: ${JSON.stringify(descriptor.capabilities)},
	createProvider: (ctx) => ${varName}({ ...${JSON.stringify(descriptor.config)}, ...ctx }),
}`);
		});

	return `
// Auto-generated media providers module
${imports.join("\n")}

/** Media provider descriptors with factory functions */
export const mediaProviders = [
  ${entries.join(",\n  ")}
];
`;
}

/**
 * Generates the block components module.
 * Collects and merges `blockComponents` exports from plugin component entries.
 */
export function generateBlockComponentsModule(descriptors: PluginDescriptor[]): string {
	const withComponents = descriptors.filter((d) => d.componentsEntry);
	if (withComponents.length === 0) {
		return `export const pluginBlockComponents = {};`;
	}

	const imports: string[] = [];
	const spreads: string[] = [];
	withComponents.forEach((d, i) => {
		imports.push(`import { blockComponents as bc${i} } from "${d.componentsEntry}";`);
		spreads.push(`...bc${i}`);
	});

	return `${imports.join("\n")}\nexport const pluginBlockComponents = { ${spreads.join(", ")} };`;
}

/**
 * Generates the seed virtual module.
 * Reads the user's seed file at build time (in Node context) and embeds it,
 * so the runtime doesn't need filesystem access (required for workerd).
 *
 * Exports `userSeed` (user's seed or null) and `seed` (user's seed or default).
 */
export function generateSeedModule(projectRoot: string): string {
	let userSeedJson: string | null = null;

	// Try .emdash/seed.json
	try {
		const seedPath = resolve(projectRoot, ".emdash", "seed.json");
		const content = readFileSync(seedPath, "utf-8");
		JSON.parse(content); // validate
		userSeedJson = content;
	} catch {
		// Not found, try next
	}

	// Try package.json → emdash.seed reference
	if (!userSeedJson) {
		try {
			const pkgPath = resolve(projectRoot, "package.json");
			const pkgContent = readFileSync(pkgPath, "utf-8");
			const pkg: { emdash?: { seed?: string } } = JSON.parse(pkgContent);

			if (pkg.emdash?.seed) {
				const seedPath = resolve(projectRoot, pkg.emdash.seed);
				const content = readFileSync(seedPath, "utf-8");
				JSON.parse(content); // validate
				userSeedJson = content;
			}
		} catch {
			// Not found
		}
	}

	if (userSeedJson) {
		return [`export const userSeed = ${userSeedJson};`, `export const seed = userSeed;`].join("\n");
	}

	// No user seed — inline the default
	return [
		`export const userSeed = null;`,
		`export const seed = ${JSON.stringify(defaultSeed)};`,
	].join("\n");
}

/**
 * Resolve a module specifier from the project's context.
 * Uses Node.js require.resolve with the project root as base.
 */
function resolveModulePathFromProject(specifier: string, projectRoot: string): string {
	// Create require from the project's package.json location
	const projectPackageJson = resolve(projectRoot, "package.json");
	const require = createRequire(projectPackageJson);
	return require.resolve(specifier);
}

/**
 * Generates the sandboxed plugins module.
 * Resolves plugin entrypoints to files, reads them, and embeds the code.
 *
 * At runtime, middleware uses SandboxRunner to load these into isolates.
 */
export function generateSandboxedPluginsModule(
	sandboxed: PluginDescriptor[],
	projectRoot: string,
): string {
	if (sandboxed.length === 0) {
		return `
// No sandboxed plugins configured
export const sandboxedPlugins = [];
`;
	}

	const pluginEntries: string[] = [];

	for (const descriptor of sandboxed) {
		const bundleSpecifier = descriptor.entrypoint;

		// Resolve the bundle to a file path using project's require context
		const filePath = resolveModulePathFromProject(bundleSpecifier, projectRoot);

		const ext = filePath.slice(filePath.lastIndexOf("."));
		if (TS_SOURCE_EXT_RE.test(ext)) {
			throw new Error(
				`Sandboxed plugin "${descriptor.id}" entrypoint "${bundleSpecifier}" resolves to ` +
					`unbuilt source (${filePath}). Sandbox entries must be pre-built JavaScript. ` +
					`Ensure the plugin's package.json exports point to built files (e.g. dist/*.mjs) ` +
					`and run the plugin's build step before building the site.`,
			);
		}

		const code = readFileSync(filePath, "utf-8");

		// Create the plugin entry with embedded code and sandbox config
		pluginEntries.push(`{
    id: ${JSON.stringify(descriptor.id)},
    version: ${JSON.stringify(descriptor.version)},
    options: ${JSON.stringify(descriptor.options ?? {})},
    capabilities: ${JSON.stringify(descriptor.capabilities ?? [])},
    allowedHosts: ${JSON.stringify(descriptor.allowedHosts ?? [])},
    storage: ${JSON.stringify(descriptor.storage ?? {})},
    adminPages: ${JSON.stringify(descriptor.adminPages ?? [])},
    adminWidgets: ${JSON.stringify(descriptor.adminWidgets ?? [])},
    adminEntry: ${JSON.stringify(descriptor.adminEntry)},
    // Code read from: ${filePath}
    code: ${JSON.stringify(code)},
  }`);
	}

	return `
// Auto-generated sandboxed plugins module
// Plugin code is embedded at build time

/**
 * Sandboxed plugin entries with embedded code.
 * Loaded at runtime via SandboxRunner.
 */
export const sandboxedPlugins = [
  ${pluginEntries.join(",\n  ")}
];
`;
}
