/**
 * Route Injection
 *
 * Defines and injects all EmDash routes into the Astro application.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve path to a route file in the package
 * Uses Node.js APIs - only call at build time
 */
function resolveRoute(route: string): string {
	// Lazy initialization to avoid running Node.js code at import time
	// This prevents issues when the module is bundled for Cloudflare Workers
	const require = createRequire(import.meta.url);
	const __dirname = dirname(fileURLToPath(import.meta.url));

	try {
		// Try to resolve as package export
		return require.resolve(`emdash/routes/${route}`);
	} catch {
		// Fallback to relative path (for development)
		return resolve(__dirname, "../routes", route);
	}
}

/** Route injection function type */
type InjectRoute = (route: { pattern: string; entrypoint: string }) => void;

/**
 * Injects all core EmDash routes.
 */
export function injectCoreRoutes(injectRoute: InjectRoute): void {
	// Inject admin shell route
	injectRoute({
		pattern: "/_emdash/admin/[...path]",
		entrypoint: resolveRoute("admin.astro"),
	});

	// Inject API routes
	injectRoute({
		pattern: "/_emdash/api/manifest",
		entrypoint: resolveRoute("api/manifest.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/dashboard",
		entrypoint: resolveRoute("api/dashboard.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]",
		entrypoint: resolveRoute("api/content/[collection]/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]",
		entrypoint: resolveRoute("api/content/[collection]/[id].ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/revisions",
		entrypoint: resolveRoute("api/content/[collection]/[id]/revisions.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/preview-url",
		entrypoint: resolveRoute("api/content/[collection]/[id]/preview-url.ts"),
	});

	// Trash/restore routes
	injectRoute({
		pattern: "/_emdash/api/content/[collection]/trash",
		entrypoint: resolveRoute("api/content/[collection]/trash.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/restore",
		entrypoint: resolveRoute("api/content/[collection]/[id]/restore.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/permanent",
		entrypoint: resolveRoute("api/content/[collection]/[id]/permanent.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/duplicate",
		entrypoint: resolveRoute("api/content/[collection]/[id]/duplicate.ts"),
	});

	// Publishing routes
	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/publish",
		entrypoint: resolveRoute("api/content/[collection]/[id]/publish.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/unpublish",
		entrypoint: resolveRoute("api/content/[collection]/[id]/unpublish.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/discard-draft",
		entrypoint: resolveRoute("api/content/[collection]/[id]/discard-draft.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/compare",
		entrypoint: resolveRoute("api/content/[collection]/[id]/compare.ts"),
	});

	// i18n translation routes
	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/translations",
		entrypoint: resolveRoute("api/content/[collection]/[id]/translations.ts"),
	});

	// Scheduled publishing routes
	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/schedule",
		entrypoint: resolveRoute("api/content/[collection]/[id]/schedule.ts"),
	});

	// Revision management routes (for restore, etc.)
	injectRoute({
		pattern: "/_emdash/api/revisions/[revisionId]",
		entrypoint: resolveRoute("api/revisions/[revisionId]/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/revisions/[revisionId]/restore",
		entrypoint: resolveRoute("api/revisions/[revisionId]/restore.ts"),
	});

	// Media API routes
	injectRoute({
		pattern: "/_emdash/api/media",
		entrypoint: resolveRoute("api/media.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/media/upload-url",
		entrypoint: resolveRoute("api/media/upload-url.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/media/file/[...key]",
		entrypoint: resolveRoute("api/media/file/[...key].ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/media/[id]",
		entrypoint: resolveRoute("api/media/[id].ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/media/[id]/confirm",
		entrypoint: resolveRoute("api/media/[id]/confirm.ts"),
	});

	// Media provider routes
	injectRoute({
		pattern: "/_emdash/api/media/providers",
		entrypoint: resolveRoute("api/media/providers/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/media/providers/[providerId]",
		entrypoint: resolveRoute("api/media/providers/[providerId]/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/media/providers/[providerId]/[itemId]",
		entrypoint: resolveRoute("api/media/providers/[providerId]/[itemId].ts"),
	});

	// Import API routes
	injectRoute({
		pattern: "/_emdash/api/import/probe",
		entrypoint: resolveRoute("api/import/probe.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/import/wordpress/analyze",
		entrypoint: resolveRoute("api/import/wordpress/analyze.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/import/wordpress/prepare",
		entrypoint: resolveRoute("api/import/wordpress/prepare.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/import/wordpress/execute",
		entrypoint: resolveRoute("api/import/wordpress/execute.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/import/wordpress/media",
		entrypoint: resolveRoute("api/import/wordpress/media.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/import/wordpress/rewrite-urls",
		entrypoint: resolveRoute("api/import/wordpress/rewrite-urls.ts"),
	});

	// WordPress Plugin (EmDash Exporter) direct import routes
	injectRoute({
		pattern: "/_emdash/api/import/wordpress-plugin/analyze",
		entrypoint: resolveRoute("api/import/wordpress-plugin/analyze.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/import/wordpress-plugin/execute",
		entrypoint: resolveRoute("api/import/wordpress-plugin/execute.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/import/wordpress-plugin/callback",
		entrypoint: resolveRoute("api/import/wordpress-plugin/callback.ts"),
	});

	// Schema API routes
	injectRoute({
		pattern: "/_emdash/api/schema",
		entrypoint: resolveRoute("api/schema/index.ts"),
	});

	// Typegen endpoint (dev-only)
	injectRoute({
		pattern: "/_emdash/api/typegen",
		entrypoint: resolveRoute("api/typegen.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/schema/collections",
		entrypoint: resolveRoute("api/schema/collections/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/schema/collections/[slug]",
		entrypoint: resolveRoute("api/schema/collections/[slug]/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/schema/collections/[slug]/fields",
		entrypoint: resolveRoute("api/schema/collections/[slug]/fields/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/schema/collections/[slug]/fields/reorder",
		entrypoint: resolveRoute("api/schema/collections/[slug]/fields/reorder.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/schema/collections/[slug]/fields/[fieldSlug]",
		entrypoint: resolveRoute("api/schema/collections/[slug]/fields/[fieldSlug].ts"),
	});

	// Orphaned tables discovery
	injectRoute({
		pattern: "/_emdash/api/schema/orphans",
		entrypoint: resolveRoute("api/schema/orphans/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/schema/orphans/[slug]",
		entrypoint: resolveRoute("api/schema/orphans/[slug].ts"),
	});

	// Site settings route
	injectRoute({
		pattern: "/_emdash/api/settings",
		entrypoint: resolveRoute("api/settings.ts"),
	});

	// Email settings route
	injectRoute({
		pattern: "/_emdash/api/settings/email",
		entrypoint: resolveRoute("api/settings/email.ts"),
	});

	// Snapshot route (for DO preview database population)
	injectRoute({
		pattern: "/_emdash/api/snapshot",
		entrypoint: resolveRoute("api/snapshot.ts"),
	});

	// Taxonomy API routes
	injectRoute({
		pattern: "/_emdash/api/taxonomies",
		entrypoint: resolveRoute("api/taxonomies/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/taxonomies/[name]/terms",
		entrypoint: resolveRoute("api/taxonomies/[name]/terms/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/taxonomies/[name]/terms/[slug]",
		entrypoint: resolveRoute("api/taxonomies/[name]/terms/[slug].ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/content/[collection]/[id]/terms/[taxonomy]",
		entrypoint: resolveRoute("api/content/[collection]/[id]/terms/[taxonomy].ts"),
	});

	// Plugin management routes (under /admin to avoid conflict with plugin API routes)
	injectRoute({
		pattern: "/_emdash/api/admin/plugins",
		entrypoint: resolveRoute("api/admin/plugins/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/plugins/[id]",
		entrypoint: resolveRoute("api/admin/plugins/[id]/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/plugins/[id]/enable",
		entrypoint: resolveRoute("api/admin/plugins/[id]/enable.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/plugins/[id]/disable",
		entrypoint: resolveRoute("api/admin/plugins/[id]/disable.ts"),
	});

	// Marketplace plugin routes
	injectRoute({
		pattern: "/_emdash/api/admin/plugins/marketplace",
		entrypoint: resolveRoute("api/admin/plugins/marketplace/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/plugins/marketplace/[id]",
		entrypoint: resolveRoute("api/admin/plugins/marketplace/[id]/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/plugins/marketplace/[id]/icon",
		entrypoint: resolveRoute("api/admin/plugins/marketplace/[id]/icon.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/plugins/marketplace/[id]/install",
		entrypoint: resolveRoute("api/admin/plugins/marketplace/[id]/install.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/plugins/[id]/update",
		entrypoint: resolveRoute("api/admin/plugins/[id]/update.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/plugins/[id]/uninstall",
		entrypoint: resolveRoute("api/admin/plugins/[id]/uninstall.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/plugins/updates",
		entrypoint: resolveRoute("api/admin/plugins/updates.ts"),
	});

	// Exclusive hooks admin routes
	injectRoute({
		pattern: "/_emdash/api/admin/hooks/exclusive",
		entrypoint: resolveRoute("api/admin/hooks/exclusive/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/hooks/exclusive/[hookName]",
		entrypoint: resolveRoute("api/admin/hooks/exclusive/[hookName].ts"),
	});

	// Theme marketplace routes
	injectRoute({
		pattern: "/_emdash/api/admin/themes/marketplace",
		entrypoint: resolveRoute("api/admin/themes/marketplace/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/themes/marketplace/[id]",
		entrypoint: resolveRoute("api/admin/themes/marketplace/[id]/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/themes/marketplace/[id]/thumbnail",
		entrypoint: resolveRoute("api/admin/themes/marketplace/[id]/thumbnail.ts"),
	});

	// Theme preview signing (local, not proxied)
	injectRoute({
		pattern: "/_emdash/api/themes/preview",
		entrypoint: resolveRoute("api/themes/preview.ts"),
	});

	// User management routes
	injectRoute({
		pattern: "/_emdash/api/admin/users",
		entrypoint: resolveRoute("api/admin/users/index.ts"),
	});

	// Bylines routes
	injectRoute({
		pattern: "/_emdash/api/admin/bylines",
		entrypoint: resolveRoute("api/admin/bylines/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/bylines/[id]",
		entrypoint: resolveRoute("api/admin/bylines/[id]/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/users/[id]",
		entrypoint: resolveRoute("api/admin/users/[id]/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/users/[id]/disable",
		entrypoint: resolveRoute("api/admin/users/[id]/disable.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/users/[id]/enable",
		entrypoint: resolveRoute("api/admin/users/[id]/enable.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/users/[id]/send-recovery",
		entrypoint: resolveRoute("api/admin/users/[id]/send-recovery.ts"),
	});

	// API token admin routes
	injectRoute({
		pattern: "/_emdash/api/admin/api-tokens",
		entrypoint: resolveRoute("api/admin/api-tokens/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/api-tokens/[id]",
		entrypoint: resolveRoute("api/admin/api-tokens/[id].ts"),
	});

	// OAuth client admin routes
	injectRoute({
		pattern: "/_emdash/api/admin/oauth-clients",
		entrypoint: resolveRoute("api/admin/oauth-clients/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/oauth-clients/[id]",
		entrypoint: resolveRoute("api/admin/oauth-clients/[id].ts"),
	});

	// OAuth Device Flow routes
	injectRoute({
		pattern: "/_emdash/api/oauth/device/code",
		entrypoint: resolveRoute("api/oauth/device/code.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/oauth/device/token",
		entrypoint: resolveRoute("api/oauth/device/token.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/oauth/device/authorize",
		entrypoint: resolveRoute("api/oauth/device/authorize.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/oauth/token/refresh",
		entrypoint: resolveRoute("api/oauth/token/refresh.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/oauth/token/revoke",
		entrypoint: resolveRoute("api/oauth/token/revoke.ts"),
	});

	// Auth discovery endpoint
	injectRoute({
		pattern: "/_emdash/.well-known/auth",
		entrypoint: resolveRoute("api/well-known/auth.ts"),
	});

	// OAuth 2.1 Authorization Code flow routes
	injectRoute({
		pattern: "/_emdash/api/oauth/token",
		entrypoint: resolveRoute("api/oauth/token.ts"),
	});

	injectRoute({
		pattern: "/_emdash/oauth/authorize",
		entrypoint: resolveRoute("api/oauth/authorize.ts"),
	});

	// OAuth discovery endpoints (RFC 9728, RFC 8414)
	injectRoute({
		pattern: "/.well-known/oauth-protected-resource",
		entrypoint: resolveRoute("api/well-known/oauth-protected-resource.ts"),
	});

	injectRoute({
		pattern: "/.well-known/oauth-authorization-server/_emdash",
		entrypoint: resolveRoute("api/well-known/oauth-authorization-server.ts"),
	});

	// RFC 7591 Dynamic Client Registration
	injectRoute({
		pattern: "/_emdash/api/oauth/register",
		entrypoint: resolveRoute("api/oauth/register.ts"),
	});

	// Plugin-defined API routes
	// All plugin routes are handled by a single catch-all handler
	injectRoute({
		pattern: "/_emdash/api/plugins/[pluginId]/[...path]",
		entrypoint: resolveRoute("api/plugins/[pluginId]/[...path].ts"),
	});

	// Menu API routes
	injectRoute({
		pattern: "/_emdash/api/menus",
		entrypoint: resolveRoute("api/menus/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/menus/[name]",
		entrypoint: resolveRoute("api/menus/[name].ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/menus/[name]/items",
		entrypoint: resolveRoute("api/menus/[name]/items.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/menus/[name]/reorder",
		entrypoint: resolveRoute("api/menus/[name]/reorder.ts"),
	});

	// Widget area routes
	injectRoute({
		pattern: "/_emdash/api/widget-areas",
		entrypoint: resolveRoute("api/widget-areas/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/widget-components",
		entrypoint: resolveRoute("api/widget-components.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/widget-areas/[name]",
		entrypoint: resolveRoute("api/widget-areas/[name].ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/widget-areas/[name]/widgets",
		entrypoint: resolveRoute("api/widget-areas/[name]/widgets.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/widget-areas/[name]/widgets/[id]",
		entrypoint: resolveRoute("api/widget-areas/[name]/widgets/[id].ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/widget-areas/[name]/reorder",
		entrypoint: resolveRoute("api/widget-areas/[name]/reorder.ts"),
	});

	// Section routes
	injectRoute({
		pattern: "/_emdash/api/sections",
		entrypoint: resolveRoute("api/sections/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/sections/[slug]",
		entrypoint: resolveRoute("api/sections/[slug].ts"),
	});

	// Redirect routes
	injectRoute({
		pattern: "/_emdash/api/redirects",
		entrypoint: resolveRoute("api/redirects/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/redirects/404s/summary",
		entrypoint: resolveRoute("api/redirects/404s/summary.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/redirects/404s",
		entrypoint: resolveRoute("api/redirects/404s/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/redirects/[id]",
		entrypoint: resolveRoute("api/redirects/[id].ts"),
	});

	// Search routes
	injectRoute({
		pattern: "/_emdash/api/search",
		entrypoint: resolveRoute("api/search/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/search/suggest",
		entrypoint: resolveRoute("api/search/suggest.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/search/stats",
		entrypoint: resolveRoute("api/search/stats.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/search/rebuild",
		entrypoint: resolveRoute("api/search/rebuild.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/search/enable",
		entrypoint: resolveRoute("api/search/enable.ts"),
	});

	// Comment routes (public)
	injectRoute({
		pattern: "/_emdash/api/comments/[collection]/[contentId]",
		entrypoint: resolveRoute("api/comments/[collection]/[contentId]/index.ts"),
	});

	// Comment routes (admin)
	injectRoute({
		pattern: "/_emdash/api/admin/comments",
		entrypoint: resolveRoute("api/admin/comments/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/comments/counts",
		entrypoint: resolveRoute("api/admin/comments/counts.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/comments/bulk",
		entrypoint: resolveRoute("api/admin/comments/bulk.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/comments/[id]/status",
		entrypoint: resolveRoute("api/admin/comments/[id]/status.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/comments/[id]",
		entrypoint: resolveRoute("api/admin/comments/[id].ts"),
	});

	// SEO routes (public, at site root)
	injectRoute({
		pattern: "/sitemap.xml",
		entrypoint: resolveRoute("sitemap.xml.ts"),
	});

	injectRoute({
		pattern: "/sitemap-[collection].xml",
		entrypoint: resolveRoute("sitemap-[collection].xml.ts"),
	});

	injectRoute({
		pattern: "/robots.txt",
		entrypoint: resolveRoute("robots.txt.ts"),
	});

	// Setup wizard API routes
	injectRoute({
		pattern: "/_emdash/api/setup/status",
		entrypoint: resolveRoute("api/setup/status.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/setup",
		entrypoint: resolveRoute("api/setup/index.ts"),
	});

	// Auth API routes
	injectRoute({
		pattern: "/_emdash/api/setup/admin",
		entrypoint: resolveRoute("api/setup/admin.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/setup/admin/verify",
		entrypoint: resolveRoute("api/setup/admin-verify.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/setup/dev-bypass",
		entrypoint: resolveRoute("api/setup/dev-bypass.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/setup/dev-reset",
		entrypoint: resolveRoute("api/setup/dev-reset.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/dev/emails",
		entrypoint: resolveRoute("api/dev/emails.ts"),
	});

	// Current user endpoint (always available)
	injectRoute({
		pattern: "/_emdash/api/auth/me",
		entrypoint: resolveRoute("api/auth/me.ts"),
	});

	// Logout is always available (though behavior differs by auth mode)
	injectRoute({
		pattern: "/_emdash/api/auth/logout",
		entrypoint: resolveRoute("api/auth/logout.ts"),
	});
}

/**
 * Injects the MCP (Model Context Protocol) server route.
 * Only injected when `mcp: true` is set in the EmDash config.
 */
export function injectMcpRoute(injectRoute: InjectRoute): void {
	injectRoute({
		pattern: "/_emdash/api/mcp",
		entrypoint: resolveRoute("api/mcp.ts"),
	});
}

/**
 * Injects passkey/oauth/magic-link auth routes.
 * Only used when NOT using external auth.
 */
export function injectBuiltinAuthRoutes(injectRoute: InjectRoute): void {
	// Passkey authentication routes
	injectRoute({
		pattern: "/_emdash/api/auth/passkey/options",
		entrypoint: resolveRoute("api/auth/passkey/options.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/passkey/verify",
		entrypoint: resolveRoute("api/auth/passkey/verify.ts"),
	});

	// Passkey management routes (authenticated users)
	injectRoute({
		pattern: "/_emdash/api/auth/passkey",
		entrypoint: resolveRoute("api/auth/passkey/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/passkey/register/options",
		entrypoint: resolveRoute("api/auth/passkey/register/options.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/passkey/register/verify",
		entrypoint: resolveRoute("api/auth/passkey/register/verify.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/passkey/[id]",
		entrypoint: resolveRoute("api/auth/passkey/[id].ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/dev-bypass",
		entrypoint: resolveRoute("api/auth/dev-bypass.ts"),
	});

	// Invite routes
	injectRoute({
		pattern: "/_emdash/api/auth/invite",
		entrypoint: resolveRoute("api/auth/invite/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/invite/accept",
		entrypoint: resolveRoute("api/auth/invite/accept.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/invite/complete",
		entrypoint: resolveRoute("api/auth/invite/complete.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/invite/register-options",
		entrypoint: resolveRoute("api/auth/invite/register-options.ts"),
	});

	// Magic link routes
	injectRoute({
		pattern: "/_emdash/api/auth/magic-link/send",
		entrypoint: resolveRoute("api/auth/magic-link/send.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/magic-link/verify",
		entrypoint: resolveRoute("api/auth/magic-link/verify.ts"),
	});

	// OAuth routes
	injectRoute({
		pattern: "/_emdash/api/auth/oauth/[provider]",
		entrypoint: resolveRoute("api/auth/oauth/[provider].ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/oauth/[provider]/callback",
		entrypoint: resolveRoute("api/auth/oauth/[provider]/callback.ts"),
	});

	// Self-signup routes
	injectRoute({
		pattern: "/_emdash/api/auth/signup/request",
		entrypoint: resolveRoute("api/auth/signup/request.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/signup/verify",
		entrypoint: resolveRoute("api/auth/signup/verify.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/auth/signup/complete",
		entrypoint: resolveRoute("api/auth/signup/complete.ts"),
	});

	// Allowed domains admin routes (only relevant for passkey mode)
	injectRoute({
		pattern: "/_emdash/api/admin/allowed-domains",
		entrypoint: resolveRoute("api/admin/allowed-domains/index.ts"),
	});

	injectRoute({
		pattern: "/_emdash/api/admin/allowed-domains/[domain]",
		entrypoint: resolveRoute("api/admin/allowed-domains/[domain].ts"),
	});
}
