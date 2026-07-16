/**
 * Vite Plugin Configuration
 *
 * Defines the Vite plugin that handles virtual modules and other
 * Vite-specific configuration for EmDash.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroConfig } from "astro";
import type { Plugin } from "vite";

import { COMMIT, VERSION } from "../../version.js";
import type { EmDashConfig, PluginDescriptor } from "./runtime.js";
import {
	VIRTUAL_CONFIG_ID,
	RESOLVED_VIRTUAL_CONFIG_ID,
	VIRTUAL_DIALECT_ID,
	RESOLVED_VIRTUAL_DIALECT_ID,
	VIRTUAL_STORAGE_ID,
	RESOLVED_VIRTUAL_STORAGE_ID,
	VIRTUAL_OBJECT_CACHE_ID,
	RESOLVED_VIRTUAL_OBJECT_CACHE_ID,
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
	VIRTUAL_AUTH_PROVIDERS_ID,
	RESOLVED_VIRTUAL_AUTH_PROVIDERS_ID,
	VIRTUAL_MEDIA_PROVIDERS_ID,
	RESOLVED_VIRTUAL_MEDIA_PROVIDERS_ID,
	VIRTUAL_BLOCK_COMPONENTS_ID,
	RESOLVED_VIRTUAL_BLOCK_COMPONENTS_ID,
	VIRTUAL_SEED_ID,
	RESOLVED_VIRTUAL_SEED_ID,
	VIRTUAL_WAIT_UNTIL_ID,
	RESOLVED_VIRTUAL_WAIT_UNTIL_ID,
	VIRTUAL_SCHEDULER_ID,
	RESOLVED_VIRTUAL_SCHEDULER_ID,
	generateSeedModule,
	generateWaitUntilModule,
	generateSchedulerModule,
	generateConfigModule,
	generateDialectModule,
	generateStorageModule,
	generateObjectCacheModule,
	generateAuthModule,
	generateAuthProvidersModule,
	generatePluginsModule,
	generateAdminRegistryModule,
	generateSandboxRunnerModule,
	generateSandboxedPluginsModule,
	generateMediaProvidersModule,
	generateBlockComponentsModule,
} from "./virtual-modules.js";

const LOCALE_MESSAGES_RE = /[/\\]([a-z]{2}(?:-[A-Z]{2})?)[/\\]messages\.mjs$/;
/**
 * Vite plugin that compiles Lingui macros in admin source files.
 * Only active in dev mode when the admin package is aliased to source for HMR.
 * @babel/core is dynamically imported from admin's devDependencies —
 * not declared by core, never ships to end users.
 */
function linguiMacroPlugin(adminSourcePath: string, adminDistPath: string): Plugin {
	// Resolve @babel/core from admin's devDependencies, not core's.
	const adminRequire = createRequire(resolve(adminDistPath, "index.js"));
	const babelCorePath = adminRequire.resolve("@babel/core");

	return {
		name: "emdash-lingui-macro",
		enforce: "pre",
		resolveId(id, importer) {
			// Redirect relative locale catalog imports (e.g. ./de/messages.mjs) from
			// within admin source to the compiled dist/locales/ directory, since
			// lingui compile only runs during build — not in dev watch mode.
			if (!importer?.startsWith(adminSourcePath)) return;
			const match = id.match(LOCALE_MESSAGES_RE);
			if (match?.[1]) {
				return resolve(adminDistPath, "locales", match[1], "messages.mjs");
			}
		},
		async transform(code, id) {
			if (!id.startsWith(adminSourcePath) || !code.includes("@lingui")) return;
			const { transformAsync } = (await import(babelCorePath)) as typeof import("@babel/core");
			const result = await transformAsync(code, {
				filename: id,
				plugins: ["@lingui/babel-plugin-lingui-macro"],
				parserOpts: { plugins: ["jsx", "typescript"] },
			});
			if (!result?.code) return;
			return { code: result.code, map: result.map ?? undefined };
		},
	};
}

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
 * Check whether child is inside parent without relying on simple prefix checks.
 */
function isInside(parent: string, child: string): boolean {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Resolve path to the admin package source directory.
 * In dev mode inside this repo, we alias @emdash-cms/admin to the source so
 * Vite processes it directly — giving instant HMR instead of requiring a
 * rebuild + restart. External apps should use the built package surface.
 */
function resolveAdminSource(projectRoot: string): string | undefined {
	const require = createRequire(import.meta.url);
	const adminPath = require.resolve("@emdash-cms/admin");
	// dist/index.js -> go up to package root, then into src/
	const packageRoot = resolve(dirname(adminPath), "..");
	const repoRoot = resolve(packageRoot, "..", "..");
	const srcEntry = resolve(packageRoot, "src", "index.ts");

	try {
		if (existsSync(srcEntry) && isInside(repoRoot, projectRoot)) {
			return resolve(packageRoot, "src");
		}
	} catch {
		// Not in local repo — fall back to dist
	}
	return undefined;
}

function resolveIntegrationShim(fileName: string): string {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	const sourceShimPath = resolve(currentDir, "shims", fileName);
	if (existsSync(sourceShimPath)) {
		return sourceShimPath;
	}
	return resolve(currentDir, "..", "..", "src", "astro", "integration", "shims", fileName);
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
export function createVirtualModulesPlugin(
	options: VitePluginOptions,
	astroCommand: "dev" | "build" | "preview" | "sync",
): Plugin {
	const { serializableConfig, resolvedConfig, pluginDescriptors, astroConfig } = options;

	let viteCommand: "build" | "serve" | undefined;

	return {
		name: "emdash-virtual-modules",
		configResolved(config) {
			viteCommand = config.command;
		},
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
			if (id === VIRTUAL_OBJECT_CACHE_ID) {
				return RESOLVED_VIRTUAL_OBJECT_CACHE_ID;
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
			if (id === VIRTUAL_AUTH_PROVIDERS_ID) {
				return RESOLVED_VIRTUAL_AUTH_PROVIDERS_ID;
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
			if (id === VIRTUAL_WAIT_UNTIL_ID) {
				return RESOLVED_VIRTUAL_WAIT_UNTIL_ID;
			}
			if (id === VIRTUAL_SCHEDULER_ID) {
				return RESOLVED_VIRTUAL_SCHEDULER_ID;
			}
		},
		load(id: string) {
			if (id === RESOLVED_VIRTUAL_CONFIG_ID) {
				return generateConfigModule(serializableConfig);
			}
			// Generate a module that statically imports the configured dialect
			// This allows Vite to properly resolve and bundle it
			if (id === RESOLVED_VIRTUAL_DIALECT_ID) {
				return generateDialectModule({
					entrypoint: resolvedConfig.database?.entrypoint,
					type: resolvedConfig.database?.type,
					supportsRequestScope: resolvedConfig.database?.supportsRequestScope ?? false,
					supportsCoalescing: resolvedConfig.database?.supportsCoalescing ?? false,
				});
			}
			// Generate a module that statically imports the configured storage
			if (id === RESOLVED_VIRTUAL_STORAGE_ID) {
				return generateStorageModule(resolvedConfig.storage?.entrypoint);
			}
			// Generate the object-cache module — statically imports the
			// configured backend factory, or exports undefined (cache off).
			if (id === RESOLVED_VIRTUAL_OBJECT_CACHE_ID) {
				return generateObjectCacheModule(
					resolvedConfig.objectCache?.entrypoint,
					resolvedConfig.objectCache?.config,
				);
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
				return generateSandboxRunnerModule(resolvedConfig.sandboxRunner, resolvedConfig.sandbox);
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
			// Generate auth providers module (pluggable login methods)
			if (id === RESOLVED_VIRTUAL_AUTH_PROVIDERS_ID) {
				return generateAuthProvidersModule(resolvedConfig.authProviders ?? []);
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
				return generateSeedModule(projectRoot, viteCommand === "serve");
			}
			// Generate wait-until module — re-exports cloudflare:workers'
			// waitUntil under the Cloudflare adapter, undefined otherwise.
			if (id === RESOLVED_VIRTUAL_WAIT_UNTIL_ID) {
				return generateWaitUntilModule(astroConfig.adapter?.name);
			}
			// Generate scheduler module — a NodeCronScheduler factory on
			// long-lived runtimes, or null under the Cloudflare adapter where
			// a Cron Trigger drives scheduled work instead.
			//
			// Decide from Astro's command, not Vite's config.command: the
			// Cloudflare adapter builds the worker bundle via a nested Vite
			// *build* pass even during `astro dev`, so viteCommand reports
			// "build" and would wrongly suppress the in-process timer (#1635).
			// Astro's command stays "dev", which is the only case that should
			// fall through to a NodeCronScheduler.
			if (id === RESOLVED_VIRTUAL_SCHEDULER_ID) {
				const schedulerCommand = astroCommand === "dev" ? "serve" : "build";
				return generateSchedulerModule(astroConfig.adapter?.name, schedulerCommand);
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
// Matches the admin stylesheet import with or without a trailing query (e.g.
// `?url`), so both forms resolve to dist rather than the source alias.
const ADMIN_STYLES_ALIAS = /^@emdash-cms\/admin\/styles\.css/;

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
	const projectRoot = fileURLToPath(options.astroConfig.root);

	const adminSourcePath = isDev ? resolveAdminSource(projectRoot) : undefined;
	const useSource = adminSourcePath !== undefined;
	const useSyncExternalStoreShimPath = resolveIntegrationShim("use-sync-external-store.js");
	const useSyncExternalStoreWithSelectorShimPath = resolveIntegrationShim(
		"use-sync-external-store-with-selector.js",
	);

	return {
		// Astro SSR routes resolve version.ts from source (not tsdown dist),
		// so Vite needs its own define pass for the __EMDASH_*__ placeholders.
		define: {
			__EMDASH_VERSION__: JSON.stringify(VERSION),
			__EMDASH_COMMIT__: JSON.stringify(COMMIT),
			__EMDASH_PSEUDO_LOCALE__: JSON.stringify(
				isDev && process.env["EMDASH_PSEUDO_LOCALE"] === "1",
			),
		},
		resolve: {
			dedupe: ["@emdash-cms/admin", "react", "react-dom"],
			// Array form so more-specific entries are checked first.
			// The styles.css alias must come before the package alias, otherwise
			// Vite's prefix matching on "@emdash-cms/admin" would resolve
			// "@emdash-cms/admin/styles.css" through the source directory.
			// Regex (not string) so the `?url` variant — admin.astro imports the
			// stylesheet as `?url` to keep it out of the page CSS graph — also
			// resolves to dist; a string `find` only matches on a `/` or end
			// boundary, so `styles.css?url` would slip through to the source alias.
			alias: [
				{ find: ADMIN_STYLES_ALIAS, replacement: resolve(adminDistPath, "styles.css") },
				{ find: "@emdash-cms/admin", replacement: useSource ? adminSourcePath : adminDistPath },
				// `use-sync-external-store/shim` is a React <18 polyfill that ships
				// only as CJS. It's pulled in transitively by `@tiptap/react`. With
				// pnpm's virtual store the file lives under .pnpm/, where Vite's
				// dep scanner can't reach it for pre-bundling — so the browser is
				// served raw `module.exports` and hydration fails with
				// `SyntaxError: ... does not provide an export named
				// 'useSyncExternalStore'`. Redirect both shim entry points to a
				// tiny ESM shim file that re-exports React's built-in hook, and
				// redirect the selector entry points to an ESM wrapper around that
				// hook. The absolute file paths are required because Vite/Rolldown
				// dependency optimization applies aliases without EmDash's virtual
				// module plugin. This also avoids the package main entry's React
				// 18+ dev warning.
				{
					find: "use-sync-external-store/shim/with-selector.js",
					replacement: useSyncExternalStoreWithSelectorShimPath,
				},
				{
					find: "use-sync-external-store/shim/with-selector",
					replacement: useSyncExternalStoreWithSelectorShimPath,
				},
				{
					find: "use-sync-external-store/shim/index.js",
					replacement: useSyncExternalStoreShimPath,
				},
				{
					find: "use-sync-external-store/shim",
					replacement: useSyncExternalStoreShimPath,
				},
			],
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Monorepo has both vite 6 (docs) and vite 7 (core). tsgo resolves correctly.
		plugins: [
			createVirtualModulesPlugin(options, command),
			// In dev mode with source alias, compile Lingui macros on the fly
			// and redirect locale .mjs imports to dist/.
			// In production, macros are pre-compiled by tsdown in the admin package.
			...(useSource ? [linguiMacroPlugin(adminSourcePath, adminDistPath)] : []),
		] as NonNullable<AstroConfig["vite"]>["plugins"],
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
						//
						// First-party packages must also stay excluded. In a
						// real install (unlike the workspace symlink, which Vite never
						// optimizes), the optimizer bundles their dist and code-splits
						// lazily-executed dynamic imports (MCP tools, content
						// validation) into hashed chunks. A mid-session re-optimization
						// deletes those chunks while loaded modules still reference
						// them, so every content write fails with "The file does not
						// exist at .../deps_ssr/..." until the dev server restarts.
						// Their CJS deps are still pre-bundled via the "parent > dep"
						// include entries below, which resolve through excluded parents.
						exclude: ["virtual:emdash", "emdash", "@emdash-cms/admin", "@emdash-cms/cloudflare"],
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
							// Only imported by the migration runner, so the first
							// dev-bypass/setup request would otherwise discover it.
							"emdash > kysely/migration",
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
							// Auth deps imported only on auth/login/callback routes, so
							// the initial page scan misses them. Pre-bundle to avoid a
							// re-optimize + reload cascade on first authenticated request.
							"emdash > @oslojs/crypto/hmac",
							"emdash > @oslojs/crypto/subtle",
							"emdash > @oslojs/crypto/rsa",
							"emdash > arctic",
							// MCP SDK — server/index.js statically imports ajv (CJS-only).
							// Pre-bundling converts CJS to ESM so workerd can load it.
							"emdash > @modelcontextprotocol/sdk > ajv",
							"emdash > @modelcontextprotocol/sdk > ajv-formats",
							// MCP server entrypoints — only imported on the MCP route, so
							// also missed by the initial scan.
							"emdash > @modelcontextprotocol/sdk/server/mcp.js",
							"emdash > @modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
							// Admin shell SSR deps, reached only when the admin route is
							// first rendered.
							"emdash > @emdash-cms/admin > @lingui/react",
							"emdash > @emdash-cms/admin > @cloudflare/kumo/primitives",
							// React (commonly used, may be hoisted)
							"react",
							"react/jsx-dev-runtime",
							"react/jsx-runtime",
							"react-dom",
							"react-dom/server",
							// Top-level deps (use astro > path for pnpm compat)
							"astro > zod/v4",
							"astro > zod/v4/core",
							"astro/zod",
							// zod-generator imports the bare `zod` entry, not `zod/v4`
							"emdash > zod",
							"@emdash-cms/cloudflare > kysely-d1",
							// Astro internal deps not covered by @astrojs/cloudflare adapter
							"astro/virtual-modules/middleware.js",
							"astro/virtual-modules/live-config",
							"astro/content/runtime",
							"astro/assets/utils/inferRemoteSize.js",
							"astro/assets/fonts/runtime.js",
							"astro/assets/services/noop",
							"@astrojs/cloudflare/image-service",
							// Only imported by the /_image route, so the first image
							// request would otherwise discover it.
							"@astrojs/cloudflare/image-transform-endpoint",
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
