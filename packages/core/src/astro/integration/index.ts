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

import { createRequire } from "node:module";

import type { AstroIntegration, AstroIntegrationLogger } from "astro";

import { validateAllowedOrigins, validateOriginShape } from "../../auth/allowed-origins.js";
import { INTERNAL_MEDIA_PREFIX } from "../../media/normalize.js";
import type { ResolvedPlugin } from "../../plugins/types.js";
import { VERSION } from "../../version.js";
import { local } from "../storage/adapters.js";
import { notoSans } from "./font-provider.js";
import {
	injectCoreRoutes,
	injectBuiltinAuthRoutes,
	injectAuthProviderRoutes,
	injectMcpRoute,
} from "./routes.js";
import type { EmDashConfig } from "./runtime.js";
import { createViteConfig } from "./vite-config.js";

// Re-export runtime types and functions
export type {
	EmDashConfig,
	PluginDescriptor,
	SandboxedPluginDescriptor,
	ResolvedPlugin,
} from "./runtime.js";
export { getStoredConfig } from "./runtime.js";

/**
 * Resolve the version of Astro the host project is building with, by reading
 * `astro/package.json` from the project's own dependency tree. Surfaced to the
 * admin and the registry install gate so a plugin's `env:astro` constraint can
 * be evaluated against the real host version. Returns `undefined` if Astro
 * can't be resolved (shouldn't happen in a real build, but never throw here).
 */
function resolveAstroVersion(): string | undefined {
	try {
		const require = createRequire(import.meta.url);
		const pkg = require("astro/package.json") as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

/** Default storage: Local filesystem in .emdash directory */
const DEFAULT_STORAGE = local({
	directory: "./.emdash/uploads",
	baseUrl: "/_emdash/api/media/file",
});

interface ImageRemotePattern {
	protocol?: "http" | "https";
	hostname?: string;
	pathname?: string;
}

/**
 * Build `image.remotePatterns` entries so Astro will optimize EmDash media.
 *
 * Astro's image services only build a transform URL for sources allowed via
 * `image.domains` / `image.remotePatterns` (relative URLs are never optimized —
 * see `isRemoteAllowed`). We authorize the media sources automatically:
 *
 *  1. The storage adapter's public URL host (R2 custom domain, S3/CDN).
 *  2. The site's own origin, scoped to the media proxy route
 *     (`/_emdash/api/media/file/**`), so same-origin proxied media is optimized.
 *     The components absolutize the media URL against this origin; EmDash's
 *     wrapped image endpoint then serves the bytes from storage (so the absolute
 *     URL is never fetched). Only registered when `siteUrl` is known at build.
 *  3. In `astro dev` the dev-server origin isn't known at build time, so we
 *     register a host-agnostic pattern scoped to the media route. Dev-only.
 *
 * Returns an empty array when no source is statically known (production build,
 * local storage, no `siteUrl`), in which case media renders as a plain `<img>`.
 *
 * @internal Exported for unit testing.
 */
export function buildImageRemotePatterns(
	storage: { config?: unknown } | undefined,
	siteUrl: string | undefined,
	command: "dev" | "build" | "preview" | "sync",
): ImageRemotePattern[] {
	const patterns: ImageRemotePattern[] = [];

	const config = storage?.config;
	const publicUrl =
		config && typeof config === "object"
			? (config as { publicUrl?: unknown }).publicUrl
			: undefined;
	if (typeof publicUrl === "string" && publicUrl) {
		try {
			const url = new URL(publicUrl);
			// Only authorize http(s) hosts — a `file:`/`ftp:` URL is not a media
			// origin Astro can fetch.
			if (url.protocol === "http:" || url.protocol === "https:") {
				const pattern: ImageRemotePattern = {
					protocol: url.protocol === "http:" ? "http" : "https",
					hostname: url.hostname,
				};
				// When the public URL has a path prefix (CDN sub-path), scope the
				// pattern to it so we don't authorize the entire host. Media keys
				// are appended as `${publicUrl}/${key}`, so the prefix is exact.
				const prefix = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
				if (prefix && prefix !== "/") {
					pattern.pathname = `${prefix}/**`;
				}
				patterns.push(pattern);
			}
		} catch {
			// ignore an unparseable public URL
		}
	}

	if (siteUrl) {
		try {
			patterns.push({
				hostname: new URL(siteUrl).hostname,
				pathname: `${INTERNAL_MEDIA_PREFIX}**`,
			});
		} catch {
			// ignore an unparseable site URL
		}
	}

	if (command === "dev") {
		patterns.push({ pathname: `${INTERNAL_MEDIA_PREFIX}**` });
	}

	return patterns;
}

/**
 * Stock image endpoints EmDash may safely replace with its storage-backed
 * wrapper. Our wrapper delegates non-EmDash images to the platform's transform
 * endpoint, so we only override endpoints whose transform we can delegate to.
 */
const OVERRIDABLE_IMAGE_ENDPOINTS = new Set([
	"astro/assets/endpoint/generic",
	"astro/assets/endpoint/node",
	"astro/assets/endpoint/dev",
	"@astrojs/cloudflare/image-transform-endpoint",
]);

/**
 * Stock endpoints that deliberately don't transform (the user opted into
 * passthrough). We leave these untouched -- and without a warning, since it's a
 * supported choice, not a custom endpoint. Overriding would route non-EmDash
 * images through a transformer the passthrough setup doesn't provide.
 */
const PASSTHROUGH_IMAGE_ENDPOINTS = new Set(["@astrojs/cloudflare/image-passthrough-endpoint"]);

/**
 * Decide which image endpoint to install (if any). EmDash wraps Astro's image
 * endpoint so EmDash media bytes load from storage; the wrapper delegates other
 * images back to the platform's stock endpoint.
 *
 * Returns `{ entrypoint }` to install, `{ warn }` to skip with a warning (a
 * custom endpoint we can't delegate to), or `{}` to skip silently (opted out).
 *
 * @internal Exported for unit testing.
 */
export function resolveImageEndpoint(opts: {
	imagesDisabled: boolean;
	currentEntrypoint: string | undefined;
	isCloudflare: boolean;
}): { entrypoint?: string; warn?: string } {
	if (opts.imagesDisabled) return {};
	const current = opts.currentEntrypoint;
	if (current === undefined || OVERRIDABLE_IMAGE_ENDPOINTS.has(current)) {
		return {
			entrypoint: opts.isCloudflare
				? "@emdash-cms/cloudflare/image-endpoint"
				: "emdash/image-endpoint",
		};
	}
	// A deliberate passthrough setup: leave it alone, no warning.
	if (PASSTHROUGH_IMAGE_ENDPOINTS.has(current)) return {};
	return {
		warn:
			`A custom image.endpoint (${current}) is configured; EmDash will not wrap ` +
			`it, so storage-backed media may render unoptimized.`,
	};
}

// Terminal formatting
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;

/** Print the EmDash startup banner */
function printBanner(_logger: AstroIntegrationLogger): void {
	const banner = `

  ${bold(cyan("— E M D A S H —"))}  ${dim(`v${VERSION}`)}
   `;
	console.log(banner);
}

/**
 * Print dev-server route info with absolute (clickable) URLs, including the
 * dev-bypass shortcut that skips passkey auth. Dev only -- the dev-bypass
 * endpoint returns 403 in production.
 */
function printDevServerInfo(baseUrl: string, mcpEnabled: boolean): void {
	const devBypassUrl = `${baseUrl}/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`;
	console.log(`\n  ${dim("›")} Admin UI    ${cyan(`${baseUrl}/_emdash/admin`)}`);
	if (mcpEnabled) {
		console.log(`  ${dim("›")} MCP server  ${cyan(`${baseUrl}/_emdash/api/mcp`)}`);
	}
	console.log(`  ${dim("›")} Dev bypass  ${cyan(devBypassUrl)}`);
	console.log(`    ${dim("Skips passkey setup/auth and signs you in as a dev admin")}`);
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

	// Validate siteUrl if provided in astro.config.mjs.
	// Env-var fallback (EMDASH_SITE_URL / SITE_URL) is handled at runtime by
	// getPublicOrigin() in api/public-url.ts — NOT here — so Docker images built
	// without a domain can pick it up at container start via process.env.
	if (resolvedConfig.siteUrl) {
		const raw = resolvedConfig.siteUrl;
		try {
			const parsed = new URL(raw);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error(`siteUrl must be http or https (got ${parsed.protocol})`);
			}
			// Always store origin-normalized value (no path) — security invariant L-1
			resolvedConfig.siteUrl = parsed.origin;
		} catch (e) {
			if (e instanceof TypeError) {
				throw new Error(`Invalid siteUrl: "${raw}"`, { cause: e });
			}
			throw e;
		}
	}

	// Validate config.allowedOrigins shape at startup (per-entry rules: parseable,
	// http(s), no trailing dots, no empty labels). The siteUrl-dependent rules
	// (Rule A: requires siteUrl; Rule B: must be a subdomain of siteUrl) are
	// deferred to runtime when config.siteUrl is absent — EMDASH_SITE_URL may
	// supply it post-build, just like the env-var fallback for siteUrl above.
	// When config.siteUrl IS present, run the full validator here for fail-fast.
	if (resolvedConfig.allowedOrigins?.length) {
		const tagged = resolvedConfig.allowedOrigins.map((origin) => ({
			origin,
			source: "config.allowedOrigins" as const,
		}));
		resolvedConfig.allowedOrigins = resolvedConfig.siteUrl
			? validateAllowedOrigins(resolvedConfig.siteUrl, tagged)
			: validateOriginShape(tagged);
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
		authProviders: resolvedConfig.authProviders,
		marketplace: resolvedConfig.marketplace,
		experimental: resolvedConfig.experimental,
		siteUrl: resolvedConfig.siteUrl,
		trustedProxyHeaders: resolvedConfig.trustedProxyHeaders,
		maxUploadSize: resolvedConfig.maxUploadSize,
		admin: resolvedConfig.admin,
	};

	// Determine auth mode for route injection
	// Check if auth is an AuthDescriptor (has entrypoint) indicating external auth
	const useExternalAuth = !!(resolvedConfig.auth && "entrypoint" in resolvedConfig.auth);

	// Captured in astro:config:setup so the astro:server:setup hook can tell
	// whether we're running `astro dev` (where the dev-bypass shortcut applies).
	let astroCommand: "dev" | "build" | "preview" | "sync" | undefined;

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
				astroCommand = command;
				printBanner(logger);
				// Capture the host's Astro version so the runtime can expose it
				// to the admin and the registry install gate for `env:astro`
				// constraint checks.
				const astroVersion = resolveAstroVersion();
				if (astroVersion !== undefined) {
					serializableConfig.astroVersion = astroVersion;
				}
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

				// Disable Astro's built-in checkOrigin -- EmDash's own CSRF
				// layer (checkPublicCsrf in api/csrf.ts) handles origin
				// validation with dual-origin support: it accepts both the
				// internal origin AND the public origin from getPublicOrigin(),
				// which resolves siteUrl from config or env vars at runtime.
				// Astro's check can't do this because allowedDomains is baked
				// at build time, which breaks Docker deployments where the
				// domain is only known at container start via EMDASH_SITE_URL.
				//
				// When siteUrl is known at build time, also set allowedDomains
				// so Astro.url reflects the public origin (helps user template
				// code that reads Astro.url directly).
				const securityConfig: Record<string, unknown> = {
					checkOrigin: false,
					...(resolvedConfig.siteUrl
						? {
								allowedDomains: [{ hostname: new URL(resolvedConfig.siteUrl).hostname }],
							}
						: {}),
				};

				// Inject default Noto Sans font for the admin UI.
				// Uses the Astro Font API so fonts are downloaded at build time
				// and self-hosted (no runtime CDN requests).
				//
				// The admin CSS references var(--font-emdash) with a system font
				// fallback. Users can add extra script coverage (Arabic, CJK, etc.)
				// by passing fonts.scripts in the emdash() config. The custom
				// notoSans provider resolves all script families from Google Fonts
				// under a single font-family name, so they stack via unicode-range.
				const fontsConfig = resolvedConfig.fonts;
				const emdashFonts =
					fontsConfig === false
						? []
						: [
								{
									provider: notoSans({
										scripts: fontsConfig?.scripts,
									}),
									name: "Noto Sans",
									cssVariable: "--font-emdash",
									weights: ["100 900" as const],
									styles: ["normal" as const, "italic" as const],
									subsets: [
										"latin" as const,
										"latin-ext" as const,
										"cyrillic" as const,
										"cyrillic-ext" as const,
										"devanagari" as const,
										"greek" as const,
										"greek-ext" as const,
										"vietnamese" as const,
									],
									fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
								},
							];

				// Authorize media sources so Astro's image service builds transform
				// URLs for them (it won't optimize an un-allowed source). `updateConfig`
				// merges arrays, so user-configured remotePatterns are preserved.
				const imageRemotePatterns = buildImageRemotePatterns(
					resolvedConfig.storage,
					resolvedConfig.siteUrl,
					command,
				);

				// Wrap Astro's image endpoint so EmDash media bytes load straight from
				// storage (Access-safe) instead of over HTTP. Skip when the user opts
				// out or has a custom endpoint we can't delegate back to.
				const { entrypoint: imageEndpoint, warn: imageEndpointWarning } = resolveImageEndpoint({
					imagesDisabled: resolvedConfig.images === false,
					currentEntrypoint: astroConfig.image?.endpoint?.entrypoint,
					isCloudflare: astroConfig.adapter?.name === "@astrojs/cloudflare",
				});
				if (imageEndpointWarning) logger.warn(imageEndpointWarning);

				const imageConfig: Record<string, unknown> = {};
				if (imageRemotePatterns.length) imageConfig.remotePatterns = imageRemotePatterns;
				if (imageEndpoint) imageConfig.endpoint = { entrypoint: imageEndpoint };

				updateConfig({
					security: securityConfig,
					...(Object.keys(imageConfig).length ? { image: imageConfig } : {}),
					// fonts is a valid AstroConfig key but may not be in the
					// type definition for the minimum supported Astro version
					...({ fonts: emdashFonts } as Record<string, unknown>),
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
				injectCoreRoutes(injectRoute, { srcDir: astroConfig.srcDir });

				// Inject routes from pluggable auth providers (authProviders config)
				if (resolvedConfig.authProviders?.length) {
					injectAuthProviderRoutes(injectRoute, resolvedConfig.authProviders);
				}

				// Inject passkey/oauth/magic-link routes unless transparent external auth is active
				if (!useExternalAuth) {
					injectBuiltinAuthRoutes(injectRoute);
				}

				// Inject MCP endpoint only when explicitly opted in
				if (resolvedConfig.mcp === true) {
					injectMcpRoute(injectRoute);
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

				// Route info is printed with absolute, clickable URLs once the
				// dev server is listening (see astro:server:setup), since the
				// port isn't known yet here. Nothing useful to print for build.
			},
			"astro:server:setup": ({ server, logger }) => {
				// Print route info with absolute, clickable URLs once the server
				// is listening. Only in `astro dev` -- the dev-bypass shortcut is
				// dev-only and the port is unknown until now.
				if (astroCommand === "dev") {
					server.httpServer?.once("listening", () => {
						const address = server.httpServer?.address();
						if (!address || typeof address === "string") return;
						let host = address.address;
						if (host === "::1" || host === "::" || host === "0.0.0.0") {
							host = "localhost";
						} else if (address.family === "IPv6") {
							host = `[${host}]`;
						}
						printDevServerInfo(`http://${host}:${address.port}`, resolvedConfig.mcp !== false);
					});
				}

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
