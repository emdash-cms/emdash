/**
 * EmDash Astro Integration
 *
 * This integration:
 * - Injects the admin shell route at /_emdash/admin/[...path].astro
 * - Sets up REST API endpoints under /_emdash/api/*
 * - Configures middleware to provide database and manifest
 *
 * NOTE: This file is for build-time only. Runtime utilities are in runtime.ts
 * to avoid bundling Node.js-only code into the production build.
 */

import type { AstroIntegration, AstroIntegrationLogger } from "astro";

import type { ResolvedPlugin } from "../../plugins/types.js";
import { local } from "../storage/adapters.js";
import { injectCoreRoutes, injectBuiltinAuthRoutes, injectMcpRoute } from "./routes.js";
import type { EmDashConfig, PluginDescriptor } from "./runtime.js";
import { createViteConfig } from "./vite-config.js";

// Re-export runtime types and functions
export type {
	EmDashConfig,
	PluginDescriptor,
	SandboxedPluginDescriptor,
	ResolvedPlugin,
} from "./runtime.js";
export { getStoredConfig } from "./runtime.js";

/** Default storage: Local filesystem in .emdash directory */
const DEFAULT_STORAGE = local({
	directory: "./.emdash/uploads",
	baseUrl: "/_emdash/api/media/file",
});

// Terminal formatting
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;

/** Print the EmDash startup banner */
function printBanner(_logger: AstroIntegrationLogger): void {
	const banner = `

  ${bold(cyan("— E M D A S H —"))}
   `;
	console.log(banner);
}

/** Print route injection summary */
function printRoutesSummary(_logger: AstroIntegrationLogger): void {
	console.log(`\n  ${dim("›")} Admin UI    ${cyan("/_emdash/admin")}`);
	console.log(`  ${dim("›")} API         ${cyan("/_emdash/api/*")}`);
	console.log("");
}

/**
 * Create the EmDash Astro integration
 */
export function emdash(config: EmDashConfig = {}): AstroIntegration {
	// Apply defaults
	const resolvedConfig: EmDashConfig = {
		...config,
		storage: config.storage ?? DEFAULT_STORAGE,
	};

	// Validate marketplace URL
	if (resolvedConfig.marketplace) {
		const url = resolvedConfig.marketplace;
		try {
			const parsed = new URL(url);
			const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
			if (parsed.protocol !== "https:" && !isLocalhost) {
				throw new Error(
					`Marketplace URL must use HTTPS (got ${parsed.protocol}). ` +
						`Only localhost URLs are allowed over HTTP.`,
				);
			}
		} catch (e) {
			if (e instanceof TypeError) {
				throw new Error(`Invalid marketplace URL: "${url}"`, { cause: e });
			}
			throw e;
		}
		if (!resolvedConfig.sandboxRunner) {
			throw new Error(
				"Marketplace requires `sandboxRunner` to be configured. " +
					"Marketplace plugins run in sandboxed V8 isolates.",
			);
		}
	}

	if (resolvedConfig.passkeyPublicOrigin) {
		const raw = resolvedConfig.passkeyPublicOrigin;
		try {
			const parsed = new URL(raw);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error(`passkeyPublicOrigin must be http or https (got ${parsed.protocol})`);
			}
			resolvedConfig.passkeyPublicOrigin = parsed.origin;
		} catch (e) {
			if (e instanceof TypeError) {
				throw new Error(`Invalid passkeyPublicOrigin: "${raw}"`, { cause: e });
			}
			throw e;
		}
	}

	// Plugin descriptors from config
	const pluginDescriptors = resolvedConfig.plugins ?? [];
	const sandboxedDescriptors = resolvedConfig.sandboxed ?? [];

	// Validate all plugin descriptors
	for (const descriptor of [...pluginDescriptors, ...sandboxedDescriptors]) {
		// Standard-format plugins can't use features that require trusted mode
		if (descriptor.format === "standard") {
			if (descriptor.adminEntry) {
				throw new Error(
					`Plugin "${descriptor.id}" is standard format but declares adminEntry. ` +
						`Standard plugins use Block Kit for admin UI, not React components. ` +
						`Remove adminEntry or change format to "native".`,
				);
			}
			if (descriptor.componentsEntry) {
				throw new Error(
					`Plugin "${descriptor.id}" is standard format but declares componentsEntry. ` +
						`Portable Text block components require native format. ` +
						`Remove componentsEntry or change format to "native".`,
				);
			}
		}
	}

	// Validate: non-standard plugins cannot be placed in sandboxed: []
	for (const descriptor of sandboxedDescriptors) {
		if (descriptor.format !== "standard") {
			throw new Error(
				`Plugin "${descriptor.id}" uses the native format and cannot be placed in ` +
					`\`sandboxed: []\`. Native plugins can only run in \`plugins: []\`. ` +
					`To sandbox this plugin, convert it to the standard format.`,
			);
		}
	}

	// Resolved plugins (populated at build time by importing entrypoints)
	let _resolvedPlugins: ResolvedPlugin[] = [];

	// Serialize config for virtual module (database/storage/auth - plugins handled separately)
	// i18n is populated in astro:config:setup from astroConfig.i18n
	const serializableConfig: Record<string, unknown> = {
		database: resolvedConfig.database,
		storage: resolvedConfig.storage,
		auth: resolvedConfig.auth,
		marketplace: resolvedConfig.marketplace,
		passkeyPublicOrigin: resolvedConfig.passkeyPublicOrigin,
		atproto: resolvedConfig.atproto,
	};

	// Determine auth mode for route injection
	// Check if auth is an AuthDescriptor (has entrypoint) indicating external auth
	const useExternalAuth = !!(resolvedConfig.auth && "entrypoint" in resolvedConfig.auth);

	return {
		name: "emdash",
		hooks: {
			"astro:config:setup": ({
				injectRoute,
				addMiddleware,
				logger,
				updateConfig,
				config: astroConfig,
				command,
			}) => {
				printBanner(logger);
				// Extract i18n config from Astro config
				// Astro locales can be strings OR { path, codes } objects — normalize to paths
				if (astroConfig.i18n) {
					const routing = astroConfig.i18n.routing;
					serializableConfig.i18n = {
						defaultLocale: astroConfig.i18n.defaultLocale,
						locales: astroConfig.i18n.locales.map((l) => (typeof l === "string" ? l : l.path)),
						fallback: astroConfig.i18n.fallback,
						prefixDefaultLocale:
							typeof routing === "object" ? (routing.prefixDefaultLocale ?? false) : false,
					};
				}

				// Update Vite config with virtual modules and other settings
				updateConfig({
					vite: createViteConfig(
						{
							serializableConfig,
							resolvedConfig,
							pluginDescriptors,
							astroConfig,
						},
						command,
					),
				});

				// Inject all core routes
				injectCoreRoutes(injectRoute);

				// Only inject passkey/oauth/magic-link routes when NOT using external auth
				if (!useExternalAuth) {
					injectBuiltinAuthRoutes(injectRoute);
				}

				// Inject MCP endpoint when enabled
				if (resolvedConfig.mcp) {
					injectMcpRoute(injectRoute);
					logger.info("MCP server enabled at /_emdash/api/mcp");
				}

				// In playground mode, inject the playground middleware FIRST.
				// It sets up a per-session DO database in ALS before anything
				// else runs, so the runtime init middleware sees a real DB.
				if (resolvedConfig.playground) {
					addMiddleware({
						entrypoint: resolvedConfig.playground.middlewareEntrypoint,
						order: "pre",
					});
				}

				// Add middleware to provide database and manifest
				addMiddleware({
					entrypoint: "emdash/middleware",
					order: "pre",
				});

				// Add redirect middleware (runs after runtime init, before setup/auth)
				addMiddleware({
					entrypoint: "emdash/middleware/redirect",
					order: "pre",
				});

				// Skip setup and auth in playground mode -- the playground middleware
				// handles session creation and injects an anonymous admin user.
				if (!resolvedConfig.playground) {
					addMiddleware({
						entrypoint: "emdash/middleware/setup",
						order: "pre",
					});

					addMiddleware({
						entrypoint: "emdash/middleware/auth",
						order: "pre",
					});
				}

				// Add request context middleware (runs after auth, on ALL routes)
				// Sets up ALS-based context for query functions (edit mode, preview)
				addMiddleware({
					entrypoint: "emdash/middleware/request-context",
					order: "pre",
				});

				printRoutesSummary(logger);
			},
			"astro:server:setup": ({ server, logger }) => {
				// Generate types once the server is listening.
				// The endpoint returns the types content; we write the file here
				// (in Node) because workerd has no real filesystem access.
				server.httpServer?.once("listening", async () => {
					const { writeFile, readFile } = await import("node:fs/promises");
					const { resolve } = await import("node:path");

					const address = server.httpServer?.address();
					if (!address || typeof address === "string") return;

					const port = address.port;
					const typegenUrl = `http://localhost:${port}/_emdash/api/typegen`;
					const outputPath = resolve(process.cwd(), "emdash-env.d.ts");

					try {
						const response = await fetch(typegenUrl, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
						});

						if (!response.ok) {
							const body = await response.text().catch(() => "");
							logger.warn(`Typegen failed: ${response.status} ${body.slice(0, 200)}`);
							return;
						}

						const { data: result } = (await response.json()) as {
							data: {
								types: string;
								hash: string;
								collections: number;
							};
						};

						// Only write if content changed
						let needsWrite = true;
						try {
							const existing = await readFile(outputPath, "utf-8");
							if (existing === result.types) needsWrite = false;
						} catch {
							// File doesn't exist yet
						}

						if (needsWrite) {
							await writeFile(outputPath, result.types, "utf-8");
							logger.info(`Generated emdash-env.d.ts (${result.collections} collections)`);
						}
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						logger.warn(`Typegen failed: ${msg}`);
					}
				});
			},
			"astro:build:done": ({ logger }) => {
				logger.info("Build complete");
			},
		},
	};
}

export default emdash;
