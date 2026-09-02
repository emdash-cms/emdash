/**
 * Playground mode route gating.
 *
 * Unlike preview mode (which blocks everything except read-only API routes),
 * playground mode allows most routes including the admin UI and write APIs.
 * Only auth, setup, and abuse-prone routes are blocked.
 *
 * Pure function -- no Worker or Cloudflare dependencies.
 */

/**
 * Routes blocked in playground mode.
 *
 * These are either security-sensitive (auth, setup, tokens, OAuth),
 * abuse-prone (media upload, plugin install), or pointless in a
 * temporary playground (snapshot export, user management).
 */
/**
 * Auth routes that ARE allowed in playground mode.
 * /auth/me is needed by the admin UI to identify the current user.
 */
const AUTH_ALLOWLIST = new Set(["/_emdash/api/auth/me"]);

const BLOCKED_PREFIXES = [
	// Auth -- playground has no real auth (except /auth/me for admin UI)
	"/_emdash/api/auth/",
	// Setup -- playground is pre-configured
	"/_emdash/api/setup/",
	// OAuth provider routes
	"/_emdash/api/oauth/",
	// API token management
	"/_emdash/api/tokens/",
	// User management (can't invite/create real users)
	"/_emdash/api/users/invite",
	// Plugin installation (security boundary)
	"/_emdash/api/plugins/install",
	"/_emdash/api/plugins/marketplace",
	// Media uploads (abuse vector -- writes are blocked in playground)
	"/_emdash/api/import/wordpress/media",
	"/_emdash/api/media/upload",
	// Snapshot export (no point exporting a playground)
	"/_emdash/api/snapshot",
];

const MEDIA_ROOT = "/_emdash/api/media";
const MEDIA_PROVIDER_PREFIX = `${MEDIA_ROOT}/providers/`;
const MEDIA_ITEM_PATH = /^\/_emdash\/api\/media\/[^/]+$/;
const MEDIA_ITEM_UPLOAD_PATH = /^\/_emdash\/api\/media\/[^/]+\/(?:upload|confirm)$/;

function trimTrailingSlashes(pathname: string): string {
	if (pathname === "/") return pathname;
	let end = pathname.length;
	while (end > 0 && pathname[end - 1] === "/") end--;
	return pathname.slice(0, end);
}

/**
 * Check whether a request should be blocked in playground mode.
 *
 * Playground allows most CMS functionality: content CRUD, schema editing,
 * taxonomies, menus, widgets, search, settings, and the full admin UI.
 * Only auth, setup, user management, media uploads, and plugin
 * installation are blocked.
 */
export function isBlockedInPlayground(pathname: string, method = "GET"): boolean {
	const normalizedPath = trimTrailingSlashes(pathname);
	// Check allowlist first -- specific routes that must work despite
	// their parent prefix being blocked (e.g. /auth/me for admin UI)
	if (AUTH_ALLOWLIST.has(normalizedPath)) {
		return false;
	}

	const normalizedMethod = method.toUpperCase();
	if (normalizedPath === MEDIA_ROOT && normalizedMethod === "POST") return true;
	if (MEDIA_ITEM_PATH.test(normalizedPath) && normalizedMethod === "DELETE") return true;
	if (MEDIA_ITEM_UPLOAD_PATH.test(normalizedPath)) return true;
	if (normalizedPath.startsWith(MEDIA_PROVIDER_PREFIX)) {
		const providerPath = normalizedPath.slice(MEDIA_PROVIDER_PREFIX.length).split("/");
		if (providerPath.length === 1 && normalizedMethod === "POST") return true;
		if (providerPath.length === 2 && normalizedMethod === "DELETE") return true;
	}

	for (const prefix of BLOCKED_PREFIXES) {
		const prefixRoot = trimTrailingSlashes(prefix);
		if (normalizedPath === prefixRoot || normalizedPath.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}
