import { defineMiddleware } from "astro:middleware";

import { apiError } from "#api/error.js";

import { readSiteWriteFence, recordSiteWrite } from "../../transfer/fence.js";

const API_PREFIX = "/_emdash/api/";

/** Write paths that media usage activation fences, in addition to transfer imports. */
const MEDIA_USAGE_FENCED_PATHS = [
	"/_emdash/api/content",
	"/_emdash/api/schema",
	"/_emdash/api/admin/media-usage/repair",
	"/_emdash/api/revisions",
	"/_emdash/api/import",
] as const;

/**
 * API write paths a transfer import does not fence: the transfer API itself,
 * sign-in and identity management, and dev-only tooling. The MCP endpoint
 * fences each tool call itself (`mcp/server.ts`), since every MCP request is
 * a POST whether the tool reads or writes.
 */
const TRANSFER_EXEMPT_PATHS = [
	"/_emdash/api/admin/transfer",
	"/_emdash/api/mcp",
	"/_emdash/api/auth",
	"/_emdash/api/oauth",
	"/_emdash/api/well-known",
	"/_emdash/api/admin/users",
	"/_emdash/api/admin/api-tokens",
	"/_emdash/api/admin/oauth-clients",
	"/_emdash/api/admin/allowed-domains",
	"/_emdash/api/setup/dev-bypass",
	"/_emdash/api/setup/dev-reset",
	"/_emdash/api/dev",
	"/_emdash/api/typegen",
] as const;

/**
 * Entry edit locks coordinate editors and hold no portable data, so neither a
 * transfer import nor a running export cares about them.
 */
const ENTRY_LOCK_PATTERN = /^\/_emdash\/api\/content\/[^/]+\/[^/]+\/lock$/;

/**
 * Plugin lifecycle routes check the site write fence themselves, after
 * authorization; fencing them here as well would query it twice. Their
 * successful writes are still recorded for running exports.
 */
const ROUTE_CHECKED_PATTERNS = [
	/^\/_emdash\/api\/admin\/plugins\/[^/]+\/(?:enable|disable|uninstall|update)$/,
	/^\/_emdash\/api\/admin\/plugins\/marketplace\/[^/]+\/install$/,
	/^\/_emdash\/api\/admin\/plugins\/registry\/[^/]+\/(?:uninstall|update)$/,
	/^\/_emdash\/api\/admin\/plugins\/registry\/install$/,
] as const;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SLASH = 0x2f;

function underPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function normalizePathname(pathname: string): string {
	let decoded = pathname;
	try {
		decoded = decodeURI(pathname);
	} catch {
		// Keep the raw pathname; the router cannot match it either.
	}
	return trimTrailingSlashes(decoded.toLowerCase());
}

function trimTrailingSlashes(path: string): string {
	let end = path.length;
	while (end > 0 && path.charCodeAt(end - 1) === SLASH) end--;
	return path.slice(0, end);
}

export interface SiteWriteRequestScope {
	transfer: boolean;
	mediaUsage: boolean;
	/** Whether a successful response is recorded as a write for running exports. */
	recordWrite: boolean;
}

/** Which fences apply to a request, or null when it is not a site write. */
export function siteWriteFenceScope(
	method: string,
	pathname: string,
): SiteWriteRequestScope | null {
	if (SAFE_METHODS.has(method.toUpperCase())) return null;
	const path = normalizePathname(pathname);
	if (!path.startsWith(API_PREFIX)) return null;
	if (ROUTE_CHECKED_PATTERNS.some((pattern) => pattern.test(path))) {
		return { transfer: false, mediaUsage: false, recordWrite: true };
	}
	const entryLock = ENTRY_LOCK_PATTERN.test(path);
	const transfer = !entryLock && !TRANSFER_EXEMPT_PATHS.some((prefix) => underPrefix(path, prefix));
	const mediaUsage = MEDIA_USAGE_FENCED_PATHS.some((prefix) => underPrefix(path, prefix));
	if (!transfer && !mediaUsage) return null;
	return { transfer, mediaUsage, recordWrite: !entryLock };
}

export const onRequest = defineMiddleware(async (context, next) => {
	const scope = siteWriteFenceScope(context.request.method, context.url.pathname);
	if (!scope) return next();
	const db = context.locals.emdash?.db;
	if (!db) return next();
	if (!scope.transfer && !scope.mediaUsage) {
		const response = await next();
		if (response.ok) await recordSiteWrite(db);
		return response;
	}
	const fence = await readSiteWriteFence(db, scope);
	if (fence.error) return apiError(fence.error.code, fence.error.message, fence.error.status);
	const response = await next();
	// Recorded after the write so an export whose fence was captured while
	// this request ran still sees it.
	if (scope.recordWrite && fence.exportRunning && response.ok) await recordSiteWrite(db);
	return response;
});

export default onRequest;
