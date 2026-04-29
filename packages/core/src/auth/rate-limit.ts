/**
 * Database-backed rate limiter for unauthenticated endpoints.
 *
 * Uses a `_emdash_rate_limits` table with composite primary key (key, window).
 * Each call to `checkRateLimit` atomically upserts a counter and returns
 * whether the request is within the allowed limit.
 *
 * Key format: `{ip}:{endpoint}` — limits are per-IP, per-endpoint.
 * Window format: ISO timestamp truncated to the window size.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { apiError } from "../api/error.js";
import type { Database } from "../database/types.js";

/** Loose validation for IPv4 and IPv6 addresses. */
const IP_PATTERN = /^[\da-fA-F.:]+$/;

/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
	/** Whether the request is allowed (within limit). */
	allowed: boolean;
	/** Current request count in this window. */
	count: number;
	/** Maximum requests allowed in this window. */
	limit: number;
}

/**
 * Check (and increment) the rate limit for a given IP + endpoint.
 *
 * If `ip` is null (no trusted IP available), rate limiting is skipped
 * and the request is allowed. There's no meaningful key to rate limit
 * on when the IP is unknown.
 *
 * Returns whether the request is allowed. The counter is always
 * incremented — even when the limit is exceeded — so that repeated
 * abuse doesn't reset the window.
 *
 * Piggybacks cleanup of expired entries with a 1% probability
 * to prevent unbounded table growth.
 */
export async function checkRateLimit(
	db: Kysely<Database>,
	ip: string | null,
	endpoint: string,
	maxRequests: number,
	windowSeconds: number,
): Promise<RateLimitResult> {
	// No trusted IP — skip rate limiting entirely
	if (!ip) {
		return { allowed: true, count: 0, limit: maxRequests };
	}

	const windowStart = new Date(
		Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000,
	).toISOString();
	const key = `${ip}:${endpoint}`;

	// Atomic upsert: insert or increment, return current count
	const result = await sql<{ count: number }>`
		INSERT INTO _emdash_rate_limits (key, window, count)
		VALUES (${key}, ${windowStart}, 1)
		ON CONFLICT (key, window)
		DO UPDATE SET count = _emdash_rate_limits.count + 1
		RETURNING count
	`.execute(db);

	const count = result.rows[0]?.count ?? 1;

	// Piggyback cleanup: 1% chance per request to clean expired entries
	if (Math.random() < 0.01) {
		cleanupExpiredRateLimits(db).catch(() => {
			// Swallow errors — cleanup is best-effort
		});
	}

	return {
		allowed: count <= maxRequests,
		count,
		limit: maxRequests,
	};
}

/**
 * Build a 429 Too Many Requests response with standard headers.
 */
export function rateLimitResponse(retryAfterSeconds: number): Response {
	const response = apiError("RATE_LIMITED", "Too many requests. Please try again later.", 429);
	response.headers.set("Retry-After", String(retryAfterSeconds));
	return response;
}

/**
 * Extract client IP from a Request.
 *
 * Resolution order:
 * 1. `CF-Connecting-IP` — trusted only when the Cloudflare `cf` object is
 *    present. CF edge overwrites any client-supplied value, so this is the
 *    cryptographically trustworthy path on Workers. Operator-declared
 *    trusted headers cannot override it.
 * 2. `X-Forwarded-For` (first entry) — trusted only when the `cf` object
 *    is present (CF sets this reliably).
 * 3. Operator-declared trusted proxy headers (ordered list) — used as a
 *    fallback for non-CF deployments behind a reverse proxy the operator
 *    controls. Also applies as a fill-in on CF when the CF headers are
 *    absent (e.g. internal cron handlers).
 * 4. `null` — no trusted IP available. Callers must handle this gracefully
 *    (e.g. skip rate limiting).
 *
 * Pass `trustedHeaders` from `getTrustedProxyHeaders(emdash.config)` so
 * self-hosted non-CF deployments can opt into reading a specific header.
 *
 * Aligned with `extractRequestMeta` in `plugins/request-meta.ts`.
 */
export function getClientIp(request: Request, trustedHeaders: string[] = []): string | null {
	const headers = request.headers;
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- CF Workers runtime shape
	const cf = (request as unknown as { cf?: Record<string, unknown> }).cf;

	// On Cloudflare, prefer the cryptographically trustworthy headers. An
	// attacker can't spoof these — the CF edge strips/overwrites them.
	if (cf) {
		const cfIp = headers.get("cf-connecting-ip")?.trim();
		if (cfIp && IP_PATTERN.test(cfIp)) {
			return cfIp;
		}

		const xff = headers.get("x-forwarded-for");
		if (xff) {
			const first = xff.split(",")[0]?.trim();
			if (first && IP_PATTERN.test(first)) {
				return first;
			}
		}
	}

	// Fall through to operator-declared trusted headers. On CF this fills
	// in when the CF headers are absent; off-CF it's the primary source.
	for (const name of trustedHeaders) {
		const value = readIpFromHeader(headers, name);
		if (value) return value;
	}

	return null;
}

/**
 * Read an IP from an operator-declared trusted header. XFF-style headers
 * are parsed as comma-separated lists and the first entry is used.
 */
function readIpFromHeader(headers: Headers, name: string): string | null {
	const value = headers.get(name);
	if (!value) return null;
	if (name.toLowerCase().endsWith("forwarded-for")) {
		const first = value.split(",")[0]?.trim();
		if (!first) return null;
		return IP_PATTERN.test(first) ? first : null;
	}
	const trimmed = value.trim();
	if (!trimmed) return null;
	return IP_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Delete expired rate limit entries.
 *
 * Entries with a window timestamp older than `maxAgeSeconds` are removed.
 * Safe to call periodically (e.g., from cron cleanup or on-request piggyback).
 */
export async function cleanupExpiredRateLimits(
	db: Kysely<Database>,
	maxAgeSeconds = 3600,
): Promise<number> {
	const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();

	const result = await sql`
		DELETE FROM _emdash_rate_limits WHERE window < ${cutoff}
	`.execute(db);

	return Number(result.numAffectedRows ?? 0);
}
