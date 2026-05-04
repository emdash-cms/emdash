/**
 * Runtime utilities for EmDash
 *
 * This file contains functions that are used at runtime (in middleware, routes, etc.)
 * and must work in all environments including Cloudflare Workers.
 *
 * DO NOT import Node.js-only modules here (fs, path, module, etc.)
 */

import type { AuthDescriptor, AuthProviderDescriptor } from "../../auth/types.js";
import type { DatabaseDescriptor } from "../../db/adapters.js";
import type { MediaProviderDescriptor } from "../../media/types.js";
import type { ResolvedPlugin } from "../../plugins/types.js";
import type { StorageDescriptor } from "../storage/types.js";

export type { ResolvedPlugin };
export type { MediaProviderDescriptor };

/**
 * Admin page definition (copied from plugins/types to avoid circular deps)
 */
export interface PluginAdminPage {
	path: string;
	label: string;
	icon?: string;
}

/**
 * Dashboard widget definition (copied from plugins/types to avoid circular deps)
 */
export interface PluginDashboardWidget {
	id: string;
	size?: "full" | "half" | "third";
	title?: string;
}

/**
 * Plugin descriptor - returned by plugin factory functions
 *
 * Contains all static metadata needed for manifest and admin UI,
 * plus the entrypoint for runtime instantiation.
 *
 * @example
 * ```ts
 * export function myPlugin(options?: MyPluginOptions): PluginDescriptor {
 *   return {
 *     id: "my-plugin",
 *     version: "1.0.0",
 *     entrypoint: "@my-org/emdash-plugin-foo",
 *     options: options ?? {},
 *     adminEntry: "@my-org/emdash-plugin-foo/admin",
 *     adminPages: [{ path: "/settings", label: "Settings" }],
 *   };
 * }
 * ```
 */
/**
 * Storage collection declaration for sandboxed plugins
 */
export interface StorageCollectionDeclaration {
	indexes?: string[];
	uniqueIndexes?: string[];
}

export interface PluginDescriptor<TOptions = Record<string, unknown>> {
	/** Unique plugin identifier */
	id: string;
	/** Plugin version (semver) */
	version: string;
	/** Module specifier to import (e.g., "@emdash-cms/plugin-api-test") */
	entrypoint: string;
	/**
	 * Options to pass to createPlugin(). Native format only.
	 * Standard-format plugins configure themselves via KV settings
	 * and Block Kit admin pages -- not constructor options.
	 */
	options?: TOptions;
	/**
	 * Plugin format. Determines how the entrypoint is loaded:
	 * - `"standard"` -- exports `definePlugin({ hooks, routes })` as default.
	 *   Wrapped with `adaptSandboxEntry` for in-process execution. Can run in both
	 *   `plugins: []` (in-process) and `sandboxed: []` (isolate).
	 * - `"native"` -- exports `createPlugin(options)` returning a `ResolvedPlugin`.
	 *   Can only run in `plugins: []`. Cannot be sandboxed or published to marketplace.
	 *
	 * Defaults to `"native"` when unset.
	 *
	 */
	format?: "standard" | "native";
	/** Admin UI module specifier (e.g., "@emdash-cms/plugin-audit-log/admin") */
	adminEntry?: string;
	/** Module specifier for site-side Astro rendering components (must export `blockComponents`) */
	componentsEntry?: string;
	/** Admin pages for navigation */
	adminPages?: PluginAdminPage[];
	/** Dashboard widgets */
	adminWidgets?: PluginDashboardWidget[];

	// === Sandbox-specific fields (for sandboxed plugins) ===

	/**
	 * Capabilities the plugin requests.
	 * For standard-format plugins, capabilities are enforced in both trusted and
	 * sandboxed modes via the PluginContextFactory.
	 */
	capabilities?: string[];
	/**
	 * Allowed hosts for network:fetch capability
	 * Supports wildcards like "*.example.com"
	 */
	allowedHosts?: string[];
	/**
	 * Storage collections the plugin declares
	 * Sandboxed plugins can only access declared collections.
	 */
	storage?: Record<string, StorageCollectionDeclaration>;
}

/**
 * Sandboxed plugin descriptor - same format as PluginDescriptor
 *
 * These run in isolated V8 isolates via Worker Loader on Cloudflare.
 * The `entrypoint` is resolved to a file and bundled at build time.
 */
export type SandboxedPluginDescriptor<TOptions = Record<string, unknown>> =
	PluginDescriptor<TOptions>;

export interface EmDashConfig {
	/**
	 * Database configuration
	 *
	 * Use one of the adapter functions:
	 * - `sqlite({ url: "file:./data.db" })` - Local SQLite
	 * - `libsql({ url: "...", authToken: "..." })` - Turso/libSQL
	 * - `d1({ binding: "DB" })` - Cloudflare D1
	 *
	 * @example
	 * ```ts
	 * import { sqlite } from "emdash/db";
	 *
	 * emdash({
	 *   database: sqlite({ url: "file:./data.db" }),
	 * })
	 * ```
	 */
	database?: DatabaseDescriptor;
	/**
	 * Storage configuration (for media)
	 */
	storage?: StorageDescriptor;
	/**
	 * Trusted plugins to load (run in main isolate)
	 *
	 * @example
	 * ```ts
	 * import { auditLogPlugin } from "@emdash-cms/plugin-audit-log";
	 * import { webhookNotifierPlugin } from "@emdash-cms/plugin-webhook-notifier";
	 *
	 * emdash({
	 *   plugins: [
	 *     auditLogPlugin(),
	 *     webhookNotifierPlugin({ url: "https://example.com/webhook" }),
	 *   ],
	 * })
	 * ```
	 */
	plugins?: PluginDescriptor[];
	/**
	 * Sandboxed plugins to load (run in isolated V8 isolates)
	 *
	 * Only works on Cloudflare with Worker Loader enabled.
	 * Uses the same format as `plugins` - the difference is where they run.
	 *
	 * @example
	 * ```ts
	 * import { untrustedPlugin } from "some-third-party-plugin";
	 *
	 * emdash({
	 *   plugins: [trustedPlugin()],     // runs in host
	 *   sandboxed: [untrustedPlugin()], // runs in isolate
	 *   sandboxRunner: "@emdash-cms/sandbox-cloudflare",
	 * })
	 * ```
	 */
	sandboxed?: SandboxedPluginDescriptor[];
	/**
	 * Module that exports the sandbox runner factory.
	 * Required if using sandboxed plugins.
	 *
	 * @example
	 * ```ts
	 * emdash({
	 *   sandboxRunner: "@emdash-cms/sandbox-cloudflare",
	 * })
	 * ```
	 */
	sandboxRunner?: string;

	/**
	 * Explicitly disable plugin sandboxing, even if a sandbox runner is configured.
	 * Use this as a debugging escape hatch to determine whether a bug is in your
	 * plugin code or in the sandbox runtime.
	 *
	 * When set to `false`, all plugins run in-process without isolation.
	 *
	 * @default true (sandboxing enabled if sandboxRunner is configured)
	 */
	sandbox?: boolean;

	/**
	 * Authentication configuration
	 *
	 * Use an auth adapter function from a platform package:
	 * - `access({ teamDomain: "..." })` from `@emdash-cms/cloudflare`
	 *
	 * When an external auth provider is configured, passkey auth is disabled.
	 *
	 * @example
	 * ```ts
	 * import { access } from "@emdash-cms/cloudflare";
	 *
	 * emdash({
	 *   auth: access({
	 *     teamDomain: "myteam.cloudflareaccess.com",
	 *     audience: "abc123...",
	 *     roleMapping: {
	 *       "Admins": 50,
	 *       "Editors": 30,
	 *     },
	 *   }),
	 * })
	 * ```
	 */
	auth?: AuthDescriptor;

	/**
	 * Pluggable auth providers (login methods on the login page).
	 *
	 * Auth providers appear as options alongside passkey on the login page
	 * and setup wizard. Any provider can be used to create the initial
	 * admin account. Passkey is built-in; providers listed here are additive.
	 *
	 * @example
	 * ```ts
	 * import { atproto } from "@emdash-cms/auth-atproto";
	 *
	 * emdash({
	 *   authProviders: [atproto()],
	 * })
	 * ```
	 */
	authProviders?: AuthProviderDescriptor[];

	/**
	 * MCP (Model Context Protocol) server endpoint.
	 *
	 * Exposes an MCP Streamable HTTP server at `/_emdash/api/mcp`
	 * that allows AI agents and tools to interact with the CMS using
	 * the standardized MCP protocol.
	 *
	 * Enabled by default. The endpoint requires bearer token auth, so
	 * it has no effect unless the user creates an API token and
	 * configures a client. Set to `false` to disable.
	 *
	 * @default true
	 */
	mcp?: boolean;

	/**
	 * Plugin marketplace URL
	 *
	 * When set, enables the marketplace features: browse, install, update,
	 * and uninstall plugins from a remote marketplace.
	 *
	 * Must be an HTTPS URL in production, or localhost/127.0.0.1 in dev.
	 * Requires `sandboxRunner` to be configured (marketplace plugins run sandboxed).
	 *
	 * @example
	 * ```ts
	 * emdash({
	 *   marketplace: "https://marketplace.emdashcms.com",
	 *   sandboxRunner: "@emdash-cms/sandbox-cloudflare",
	 * })
	 * ```
	 */
	marketplace?: string;

	/**
	 * Maximum allowed media file upload size in bytes.
	 *
	 * Applies to both direct multipart uploads and signed-URL uploads.
	 * When unset, defaults to 52_428_800 (50 MB).
	 *
	 * @example
	 * ```ts
	 * emdash({ maxUploadSize: 100 * 1024 * 1024 }) // 100 MB
	 * ```
	 */
	maxUploadSize?: number;

	/**
	 * Public browser-facing origin for the site.
	 *
	 * Use when `Astro.url` / `request.url` do not match what users open — common with a
	 * **TLS-terminating reverse proxy**: the app often sees `http://` on the internal hop
	 * while the browser uses `https://`, which breaks WebAuthn, CSRF, OAuth, and redirect URLs.
	 *
	 * Set to the full origin users type in the address bar (no path), e.g.
	 * `https://mysite.example.com`. When not set, falls back to environment variables
	 * `EMDASH_SITE_URL` > `SITE_URL`, then to the request URL's origin.
	 *
	 * Replaces `passkeyPublicOrigin` (which only fixed passkeys).
	 */
	siteUrl?: string;

	/**
	 * Additional origins accepted by passkey verification.
	 *
	 * When the same EmDash deployment is reachable under several hostnames sharing
	 * a registrable parent (e.g. `https://example.com` plus
	 * `https://preview.example.com`), the canonical `siteUrl` defines the `rpId`
	 * and the entries here are the *additional* origins from which assertions
	 * are accepted. Each entry must be the same hostname as `siteUrl` or a
	 * subdomain of it — WebAuthn requires `rpId` to be a registrable suffix of
	 * every origin.
	 *
	 * Merged at runtime with the `EMDASH_ALLOWED_ORIGINS` env var (comma-separated).
	 * Validation:
	 *   - Config-declared entries are shape-checked at Astro startup.
	 *   - Subdomain relationship to `siteUrl` is checked at startup when
	 *     `siteUrl` is also config-declared, otherwise at first passkey
	 *     verification (since `siteUrl` may come from `EMDASH_SITE_URL`).
	 *
	 * Mismatches throw with a source-attributed message naming
	 * `config.allowedOrigins` or `EMDASH_ALLOWED_ORIGINS`.
	 *
	 * @example
	 * ```ts
	 * emdash({
	 *   siteUrl: "https://example.com",
	 *   allowedOrigins: ["https://preview.example.com"],
	 * })
	 * ```
	 */
	allowedOrigins?: string[];
	/*
	 * Headers to trust for client IP resolution when running behind a reverse
	 * proxy. The first header in this list that is present on the request
	 * wins. Applies to rate limiting for auth endpoints and comment
	 * submission.
	 *
	 * Common values:
	 * - `x-real-ip` — nginx, Caddy, Traefik
	 * - `fly-client-ip` — Fly.io
	 * - `x-forwarded-for` — generic (first entry is used)
	 *
	 * Only set this when you **control the reverse proxy**. Untrusted
	 * clients can set any header they like; trusting headers from an open
	 * network is an IP-spoofing vulnerability that defeats rate limiting.
	 *
	 * On Cloudflare the `cf` object on the request is used automatically —
	 * you normally don't need to set this. Leave unset (or empty) to
	 * preserve the default: IP is resolved only when the request came
	 * through Cloudflare's edge.
	 *
	 * Falls back to `EMDASH_TRUSTED_PROXY_HEADERS` env var (comma-separated)
	 * when this option is not set, so operators can configure at deploy
	 * time without touching the Astro config.
	 */
	trustedProxyHeaders?: string[];

	/**
	 * Enable playground mode for ephemeral "try EmDash" sites.
	 *
	 * When set, the integration injects a playground middleware (order: "pre")
	 * that runs BEFORE the normal EmDash middleware chain. It creates an
	 * isolated Durable Object database per session, runs migrations, applies
	 * the seed, creates an anonymous admin user, and sets the DB in ALS.
	 * By the time the runtime middleware runs, the database is fully ready.
	 *
	 * Setup and auth middleware are skipped (the playground handles both).
	 *
	 * Requires `@emdash-cms/cloudflare` as a dependency and a DO binding
	 * in wrangler.jsonc.
	 *
	 * @example
	 * ```ts
	 * emdash({
	 *   database: playgroundDatabase({ binding: "PLAYGROUND_DB" }),
	 *   playground: {
	 *     middlewareEntrypoint: "@emdash-cms/cloudflare/db/playground-middleware",
	 *   },
	 * })
	 * ```
	 */
	playground?: {
		/** Module path for the playground middleware. */
		middlewareEntrypoint: string;
	};

	/**
	 * Media providers for browsing and uploading media
	 *
	 * The local media provider (using storage adapter) is available by default.
	 * Additional providers can be added for external services like Unsplash,
	 * Cloudinary, Mux, Cloudflare Images, etc.
	 *
	 * @example
	 * ```ts
	 * import { cloudflareImages, cloudflareStream } from "@emdash-cms/cloudflare";
	 * import { unsplash } from "@emdash-cms/provider-unsplash";
	 *
	 * emdash({
	 *   mediaProviders: [
	 *     cloudflareImages({ accountId: "..." }),
	 *     cloudflareStream({ accountId: "..." }),
	 *     unsplash({ accessKey: "..." }),
	 *   ],
	 * })
	 * ```
	 */
	mediaProviders?: MediaProviderDescriptor[];

	/**
	 * Admin UI font configuration.
	 *
	 * By default, EmDash loads Noto Sans via the Astro Font API, covering
	 * Latin, Latin Extended, Cyrillic, Cyrillic Extended, Greek, Greek
	 * Extended, Devanagari, and Vietnamese. Fonts are downloaded from
	 * Google at build time and self-hosted, so there are no runtime CDN
	 * requests.
	 *
	 * To add support for additional writing systems (Arabic, CJK, etc.),
	 * pass script names. EmDash resolves the matching Noto Sans variant
	 * from Google Fonts and merges all script faces under a single
	 * font-family, so the browser downloads only the glyphs it needs
	 * via unicode-range.
	 *
	 * Set to `false` to disable font injection entirely and use system fonts.
	 *
	 * @example
	 * ```ts
	 * // Add Arabic and Japanese support
	 * emdash({
	 *   fonts: {
	 *     scripts: ["arabic", "japanese"],
	 *   },
	 * })
	 * ```
	 *
	 * @example
	 * ```ts
	 * // Disable web fonts entirely (use system fonts)
	 * emdash({
	 *   fonts: false,
	 * })
	 * ```
	 */
	fonts?:
		| false
		| {
				/**
				 * Additional Noto Sans script families to include.
				 *
				 * Available scripts: arabic, armenian, bengali, chinese-simplified,
				 * chinese-traditional, chinese-hongkong, devanagari, ethiopic, farsi,
				 * georgian, gujarati, gurmukhi, hebrew, japanese, kannada, khmer,
				 * korean, lao, malayalam, myanmar, oriya, sinhala, tamil, telugu,
				 * thai, tibetan.
				 */
				scripts?: string[];
		  };

	/**
	 * Admin UI branding (white-labeling).
	 *
	 * Overrides the default EmDash logo and name in the admin panel.
	 * Use this to white-label the CMS for agency or enterprise deployments.
	 * These settings are separate from the public site settings (title, logo,
	 * favicon) which remain available for SEO and front-end use.
	 *
	 * @example
	 * ```ts
	 * emdash({
	 *   admin: {
	 *     logo: "/images/agency-logo.webp",
	 *     siteName: "AgencyX CMS",
	 *     favicon: "/favicon.ico",
	 *   },
	 * })
	 * ```
	 */
	admin?: {
		/** URL or path to a custom logo image for the admin UI (login page, sidebar). */
		logo?: string;
		/** Custom name displayed in the admin sidebar and browser tab. */
		siteName?: string;
		/** URL or path to a custom favicon for the admin panel. */
		favicon?: string;
	};
}

/**
 * Get stored config from global
 * This is set by the virtual module at build time
 */
export function getStoredConfig(): EmDashConfig | null {
	return globalThis.__emdashConfig || null;
}

/**
 * Set stored config in global
 * Called by the integration at config time
 */
export function setStoredConfig(config: EmDashConfig): void {
	globalThis.__emdashConfig = config;
}

// Declare global type
declare global {
	// eslint-disable-next-line no-var
	var __emdashConfig: EmDashConfig | undefined;
}
