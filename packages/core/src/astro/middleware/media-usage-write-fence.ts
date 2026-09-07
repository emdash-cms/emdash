import { defineMiddleware } from "astro:middleware";

import { checkMediaUsageActivationWriteFence } from "#api/media-usage-write-fence.js";

const FENCED_WRITE_PATHS = [
	"/_emdash/api/content",
	"/_emdash/api/schema",
	"/_emdash/api/admin/media-usage/repair",
	"/_emdash/api/revisions",
	"/_emdash/api/import",
	"/_emdash/api/mcp",
] as const;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const onRequest = defineMiddleware(async (context, next) => {
	if (!isFencedWriteRequest(context.request.method, context.url.pathname)) return next();
	const db = context.locals.emdash?.db;
	if (!db) return next();
	return (await checkMediaUsageActivationWriteFence(db)) ?? next();
});

function isFencedWriteRequest(method: string, pathname: string): boolean {
	if (SAFE_METHODS.has(method.toUpperCase())) return false;
	return FENCED_WRITE_PATHS.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

export default onRequest;
