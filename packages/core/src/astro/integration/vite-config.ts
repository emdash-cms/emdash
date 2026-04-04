/**
 * Vite Plugin Configuration
 *
 * Defines the Vite plugin that handles virtual modules and other
 * Vite-specific configuration for EmDash.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroConfig } from "astro";
import type { Plugin } from "vite";

import type { EmDashConfig, PluginDescriptor } from "./runtime.js";
import {
	VIRTUAL_CONFIG_ID,
	RESOLVED_VIRTUAL_CONFIG_ID,
	VIRTUAL_DIALECT_ID,
	RESOLVED_VIRTUAL_DIALECT_ID,
	VIRTUAL_STORAGE_ID,
	RESOLVED_VIRTUAL_STORAGE_ID,
	VIRTUAL_ADMIN_REGISTRY_ID,
	RESOLVED_VIRTUAL_ADMIN_REGISTRY_ID,
	VIRTUAL_PLUGINS_ID,
	RESOLVED_VIRTUAL_PLUGINS_ID,
	VIRTUAL_SANDBOX_RUNNER_ID,
	RESOLVED_VIRTUAL_SANDBOX_RUNNER_ID,
	VIRTUAL_SANDBOXED_PLUGINS_ID,
	RESOLVED_VIRTUAL_SANDBOXED_PLUGINS_ID,
	VIRTUAL_AUTH_ID,
	RESOLVED_VIRTUAL_AUTH_ID,
	VIRTUAL_MEDIA_PROVIDERS_ID,
	RESOLVED_VIRTUAL_MEDIA_PROVIDERS_ID,
	VIRTUAL_BLOCK_COMPONENTS_ID,
	RESOLVED_VIRTUAL_BLOCK_COMPONENTS_ID,
	VIRTUAL_SEED_ID,
	RESOLVED_VIRTUAL_SEED_ID,
	generateSeedModule,
	generateConfigModule,
	generateDialectModule,
	generateStorageModule,
	generateAuthModule,
	generatePluginsModule,
	generateAdminRegistryModule,
	generateSandboxRunnerModule,
	generateSandboxedPluginsModule,
	generateMediaProvidersModule,
	generateBlockComponentsModule,
} from "./virtual-modules.js";

/**
 * Resolve path to the admin package dist directory.
 * Used for Vite alias to ensure the package is found in pnpm's isolated node_modules.
 */
function resolveAdminDist(): string {
	const require = createRequire(import.meta.url);
	const adminPath = require.resolve("@emdash-cms/admin");
	// Return the directory containing the built package (dist/)
	return dirname(adminPath);
}

/**
 * Resolve path to the admin package source directory.
 * In dev mode, we alias @emdash-cms/admin to the source so Vite processes it
 * directly — giving instant HMR instead of requiring a rebuild + restart.
 */
function resolveAdminSource(): string | undefined {
	const require = createRequire(import.meta.url);
	const adminPath = require.resolve("@emdash-cms/admin");
	// dist/index.js -> go up to package root, then into src/
	const packageRoot = resolve(dirname(adminPath), "..");
	const srcEntry = resolve(packageRoot, "src", "index.ts");

	// Only use source alias if the source directory actually exists
	// (won't exist in published packages, only in the monorepo)
	try {
		// Use require.resolve mechanics — if the file exists, return the source dir
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- CJS require returns any
		const fs = require("node:fs") as typeof import("node:fs");
		if (fs.existsSync(srcEntry)) {
			return resolve(packageRoot, "src");
		}
	} catch {
		// Not in monorepo — fall back to dist
	}
	return undefined;
}

export interface VitePluginOptions {
	/** Serializable config (database, storage, auth descriptors) */
	serializableConfig: Record<string, unknown>;
	/** Resolved EmDash config */
	resolvedConfig: EmDashConfig;
	/** Plugin descriptors */
	pluginDescriptors: PluginDescriptor[];
	/** Astro config */
	astroConfig: AstroConfig;
}

/**
 * Creates the EmDash virtual modules Vite plugin.
 */
export function createVirtualModulesPlugin(options: VitePluginOptions): Plugin {
	const { serializableConfig, resolvedConfig, pluginDescriptors, astroConfig } = options;

	return {
		name: "emdash-virtual-modules",
		resolveId(id: string) {
			if (id === VIRTUAL_CONFIG_ID) {
				return RESOLVED_VIRTUAL_CONFIG_ID;
			}
			if (id === VIRTUAL_DIALECT_ID) {
				return RESOLVED_VIRTUAL_DIALECT_ID;
			}
			if (id === VIRTUAL_STORAGE_ID) {
				return RESOLVED_VIRTUAL_STORAGE_ID;
			}
			if (id === VIRTUAL_ADMIN_REGISTRY_ID) {
				return RESOLVED_VIRTUAL_ADMIN_REGISTRY_ID;
			}
			if (id === VIRTUAL_PLUGINS_ID) {
				return RESOLVED_VIRTUAL_PLUGINS_ID;
			}
			if (id === VIRTUAL_SANDBOX_RUNNER_ID) {
				return RESOLVED_VIRTUAL_SANDBOX_RUNNER_ID;
			}
			if (id === VIRTUAL_SANDBOXED_PLUGINS_ID) {
				return RESOLVED_VIRTUAL_SANDBOXED_PLUGINS_ID;
			}
			if (id === VIRTUAL_AUTH_ID) {
				return RESOLVED_VIRTUAL_AUTH_ID;
			}
			if (id === VIRTUAL_MEDIA_PROVIDERS_ID) {
				return RESOLVED_VIRTUAL_MEDIA_PROVIDERS_ID;
			}
			if (id === VIRTUAL_BLOCK_COMPONENTS_ID) {
				return RESOLVED_VIRTUAL_BLOCK_COMPONENTS_ID;
			}
			if (id === VIRTUAL_SEED_ID) {
				return RESOLVED_VIRTUAL_SEED_ID;
			}
		},
		load(id: string) {
			if (id === RESOLVED_VIRTUAL_CONFIG_ID) {
				return generateConfigModule(serializableConfig);
			}
			// Generate a module that statically imports the configured dialect
			// This allows Vite to properly resolve and bundle it
			if (id === RESOLVED_VIRTUAL_DIALECT_ID) {
				return generateDialectModule(
					resolvedConfig.database?.entrypoint,
					resolvedConfig.database?.type,
					resolvedConfig.database?.config,
				);
			}
			// Generate a module that statically imports the configured storage
			if (id === RESOLVED_VIRTUAL_STORAGE_ID) {
				return generateStorageModule(resolvedConfig.storage?.entrypoint);
			}
			// Generate plugins module that imports and instantiates all plugins
			if (id === RESOLVED_VIRTUAL_PLUGINS_ID) {
				return generatePluginsModule(pluginDescriptors);
			}
			// Generate admin registry module with plugin components
			if (id === RESOLVED_VIRTUAL_ADMIN_REGISTRY_ID) {
				// Include both trusted and sandboxed plugins
				const allDescriptors = [...pluginDescriptors, ...(resolvedConfig.sandboxed ?? [])];
				return generateAdminRegistryModule(allDescriptors);
			}
			// Generate sandbox runner module
			if (id === RESOLVED_VIRTUAL_SANDBOX_RUNNER_ID) {
				return generateSandboxRunnerModule(resolvedConfig.sandboxRunner);
			}
			// Generate sandboxed plugins config module
			if (id === RESOLVED_VIRTUAL_SANDBOXED_PLUGINS_ID) {
				// Pass project root for proper module resolution
				const projectRoot = fileURLToPath(astroConfig.root);
				return generateSandboxedPluginsModule(resolvedConfig.sandboxed ?? [], projectRoot);
			}
			// Generate auth module that statically imports the configured auth provider
			if (id === RESOLVED_VIRTUAL_AUTH_ID) {
				const authDescriptor = resolvedConfig.auth;
				if (!authDescriptor || !("entrypoint" in authDescriptor)) {
					return generateAuthModule(undefined);
				}
				return generateAuthModule(authDescriptor.entrypoint);
			}
			// Generate media providers module
			if (id === RESOLVED_VIRTUAL_MEDIA_PROVIDERS_ID) {
				return generateMediaProvidersModule(resolvedConfig.mediaProviders ?? []);
			}
			// Generate block components module (plugin rendering components for PortableText)
			if (id === RESOLVED_VIRTUAL_BLOCK_COMPONENTS_ID) {
				return generateBlockComponentsModule(pluginDescriptors);
			}
			// Generate seed module — embeds user seed or default at build time
			if (id === RESOLVED_VIRTUAL_SEED_ID) {
				const projectRoot = fileURLToPath(astroConfig.root);
				return generateSeedModule(projectRoot);
			}
		},
	};
}

/**
 * Creates a Vite plugin that ensures PluginBridge is exported from the
 * Worker entry point when a sandbox runner is configured.
 *
 * The Cloudflare sandbox runner needs PluginBridge to be a named export
 * of the main Worker module so it's accessible via cloudflare:workers
 * exports at runtime. The Astro Cloudflare adapter only generates a
 * default export in entry.mjs, so this plugin appends the named export
 * during the build.
 */
function createPluginBridgeExportPlugin(sandboxRunner?: string): Plugin | null {
	if (!sandboxRunner) return null;

	return {
		name: "emdash-plugin-bridge-export",
		enforce: "post",
		generateBundle(_, bundle) {
			// Find the entry chunk (entry.mjs)
			for (const [fileName, chunk] of Object.entries(bundle)) {
				if (chunk.type === "chunk" && chunk.isEntry && fileName.endsWith(".mjs")) {
					// Find which chunk contains the PluginBridge export from the
					// virtual sandbox-runner module. The build graph includes it
					// because the virtual module re-exports it.
					let bridgeChunk: string | null = null;
					for (const [name, c] of Object.entries(bundle)) {
						if (
							c.type === "chunk" &&
							c.code.includes("PluginBridge") &&
							c.code.includes("WorkerEntrypoint")
						) {
							// Use the chunk's path relative to the entry
							bridgeChunk = name;
							break;
						}
					}

					if (bridgeChunk) {
						// Compute the import path relative to entry.mjs
						const importPath = "./" + bridgeChunk;
						chunk.code += `\nimport { PluginBridge } from "${importPath}";\nexport { PluginBridge };\n`;
					}
					break;
				}
			}
		},
	};
}

/**
 * Modules that contain native Node.js addons or Node-only code.
 * These must be external in SSR to avoid bundling failures on Node.
 * On Cloudflare, the adapter handles its own externalization — setting
 * ssr.external there conflicts with @cloudflare/vite-plugin's validation.
 */
const NODE_NATIVE_EXTERNALS = [
	"better-sqlite3",
	"bindings",
	"file-uri-to-path",
	"@libsql/kysely-libsql",
	"pg",
];

/**
 * Detect whether the Cloudflare adapter is being used.
 */
function isCloudflareAdapter(astroConfig: AstroConfig): boolean {
	return astroConfig.adapter?.name === "@astrojs/cloudflare";
}

/**
 * Creates the Vite config update for EmDash.
 */
export function createViteConfig(
	options: VitePluginOptions,
	command: "dev" | "build" | "preview" | "sync",
): NonNullable<AstroConfig["vite"]> {
	const adminDistPath = resolveAdminDist();
	const cloudflare = isCloudflareAdapter(options.astroConfig);
	const isDev = command === "dev";

	// In dev mode within the monorepo, alias JS imports to source for instant HMR.
	// CSS always comes from dist/ (pre-compiled by @tailwindcss/cli) since Tailwind's
	// Vite plugin has native deps that don't bundle well. Run `pnpm dev` in packages/admin
	// alongside the demo server to get CSS watch-rebuilds too.
	const adminSourcePath = isDev ? resolveAdminSource() : undefined;
	const useSource = adminSourcePath !== undefined;

	return {
		resolve: {
			dedupe: ["@emdash-cms/admin", "react", "react-dom"],
			// Array form so more-specific entries are checked first.
			// The styles.css alias must come before the package alias, otherwise
			// Vite's prefix matching on "@emdash-cms/admin" would resolve
			// "@emdash-cms/admin/styles.css" through the source directory.
			alias: [
				// CSS: always dist (pre-compiled by @tailwindcss/cli)
				{ find: "@emdash-cms/admin/styles.css", replacement: resolve(adminDistPath, "styles.css") },
				// JS: source in dev (HMR), dist in build
				{ find: "@emdash-cms/admin", replacement: useSource ? adminSourcePath : adminDistPath },
			],
		},
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Monorepo has both vite 6 (docs) and vite 7 (core). tsgo resolves correctly.
		plugins: [
			createVirtualModulesPlugin(options),
			...(cloudflare ? [createPluginBridgeExportPlugin(options.resolvedConfig.sandboxRunner)] : []),
		].filter(Boolean) as NonNullable<AstroConfig["vite"]>["plugins"],
		// Handle native modules for SSR.
		// On Node: external keeps native addons out of the SSR bundle.
		// On Cloudflare: skip — the adapter handles externalization, and setting
		// ssr.external conflicts with @cloudflare/vite-plugin's resolve.external validation.
		ssr: cloudflare
			? {
					noExternal: ["emdash", "@emdash-cms/admin"],
					// Pre-bundle EmDash's runtime deps for workerd. Without this,
					// Vite discovers them one-by-one on first request, causing workerd
					// to enter "worker cancelled" state on cold cache.
					optimizeDeps: {
						// Exclude EmDash virtual modules from esbuild's dependency
						// scan. These are resolved by the Vite plugin at transform time,
						// but esbuild encounters them when crawling emdash's dist files
						// during pre-bundling and can't resolve them. Vite's exclude
						// uses prefix matching (id.startsWith(m + "/")), so
						// "virtual:emdash" matches all "virtual:emdash/*" imports.
						exclude: ["virtual:emdash"],
						include: [
							// EmDash direct deps
							"emdash > @portabletext/toolkit",
							"emdash > @unpic/placeholder",
							"emdash > blurhash",
							"emdash > croner",
							"emdash > image-size",
							"emdash > jose",
							"emdash > jpeg-js",
							"emdash > kysely",
							"emdash > mime/lite",
							"emdash > modern-tar",
							"emdash > sanitize-html",
							"emdash > ulidx",
							"emdash > upng-js",
							"emdash > astro-portabletext",
							"emdash > sax",
							// Deeper transitive deps
							"emdash > sanitize-html > parse5",
							"emdash > @emdash-cms/gutenberg-to-portable-text > @wordpress/block-serialization-default-parser",
							"emdash > @emdash-cms/auth > @oslojs/crypto/ecdsa",
							"emdash > @emdash-cms/auth > @oslojs/crypto/sha2",
							"emdash > @emdash-cms/auth > @oslojs/webauthn",
							// React (commonly used, may be hoisted)
							"react",
							"react/jsx-dev-runtime",
							"react/jsx-runtime",
							"react-dom",
							"react-dom/server",
							// Top-level deps (use astro > path for pnpm compat)
							"astro > zod/v4",
							"astro > zod/v4/core",
							"@emdash-cms/cloudflare > kysely-d1",
							// Astro internal deps not covered by @astrojs/cloudflare adapter
							"astro/virtual-modules/middleware.js",
							"astro/virtual-modules/live-config",
							"astro/content/runtime",
							"astro/assets/utils/inferRemoteSize.js",
							"astro/assets/fonts/runtime.js",
							"@astrojs/cloudflare/image-service",
						],
					},
				}
			: {
					external: NODE_NATIVE_EXTERNALS,
					noExternal: ["emdash", "@emdash-cms/admin"],
				},
		optimizeDeps: {
			// When using source, don't pre-bundle JS — let Vite transform on the fly for HMR.
			// When using dist, pre-bundle to avoid re-optimization on first hydration.
			include: useSource
				? ["@astrojs/react/client.js"]
				: ["@emdash-cms/admin", "@astrojs/react/client.js"],
			exclude: cloudflare ? ["virtual:emdash"] : [...NODE_NATIVE_EXTERNALS, "virtual:emdash"],
		},
	};
}
