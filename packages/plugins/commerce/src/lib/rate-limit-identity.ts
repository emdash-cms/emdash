/**
 * Shared actor identifiers for request-based rate limiting.
 * We prefer concrete client IP when available, then trusted proxy headers,
 * then deterministic route/session fallbacks.
 */

import { sha256HexAsync } from "./crypto-adapter.js";

type RateLimitIdentityContext = {
	request: {
		headers: Headers;
		url: string;
	};
	requestMeta: {
		ip?: string | null;
	};
};

function normalizeIp(raw?: string | null): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed || trimmed.toLowerCase() === "unknown") {
		return undefined;
	}
	return trimmed;
}

function parseForwardedIp(raw: string | null): string | undefined {
	if (!raw) return undefined;
	const first = raw.split(",")[0]?.trim();
	return normalizeIp(first);
}

function fallbackRateLimitActor(scope: string, ctx: RateLimitIdentityContext): string {
	const userAgent = normalizeIp(ctx.request.headers.get("user-agent"));
	if (userAgent) {
		return `${scope}:ua:${userAgent}`;
	}

	const requestId = normalizeIp(
		ctx.request.headers.get("x-request-id") || ctx.request.headers.get("cf-ray"),
	);
	if (requestId) {
		return `${scope}:rid:${requestId}`;
	}

	let pathname = "unknown";
	try {
		pathname = new URL(ctx.request.url).pathname;
	} catch {
		// Request urls are usually absolute, but stay deterministic in odd test/runtime cases.
		pathname = "/";
	}
	return `${scope}:path:${pathname}`;
}

export async function buildRateLimitActorKey(
	ctx: RateLimitIdentityContext,
	scope: string,
): Promise<string> {
	const ipFromMetadata = normalizeIp(ctx.requestMeta.ip);
	const ipFromHeaders =
		parseForwardedIp(ctx.request.headers.get("x-forwarded-for")) ??
		parseForwardedIp(ctx.request.headers.get("x-real-ip"));

	const actor = ipFromMetadata ?? ipFromHeaders ?? fallbackRateLimitActor(scope, ctx);
	const digest = await sha256HexAsync(actor);
	return digest.slice(0, 32);
}
