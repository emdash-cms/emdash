/**
 * Request Metadata Extraction
 *
 * Extracts normalized metadata (IP, user agent, referer, geo) from
 * incoming requests. Used by plugin route handlers to access request
 * context without touching raw headers.
 *
 */

import type { GeoInfo, RequestMeta } from "./types.js";

/**
 * Cloudflare Workers `cf` object shape (subset we use).
 * Present on requests when running on Cloudflare Workers.
 */
interface CfProperties {
	country?: string;
	region?: string;
	city?: string;
}

/**
 * Loose validation for IPv4 and IPv6 addresses.
 * Accepts digits, hex chars, dots, and colons — rejects anything else
 * (e.g. HTML tags, scripts, or other non-IP garbage in spoofed headers).
 */
const IP_PATTERN = /^[\da-fA-F.:]+$/;

/**
 * Extract the first IP from an X-Forwarded-For header value.
 * The header may contain a comma-separated list of IPs; the first
 * entry is the original client IP.
 *
 * Returns null if the extracted value doesn't look like an IP address.
 */
function parseFirstForwardedIp(header: string): string | null {
	const first = header.split(",")[0];
	const trimmed = first?.trim();
	if (!trimmed) return null;
	return IP_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Get the Cloudflare `cf` object from the request, if present.
 * Returns undefined when not running on Cloudflare Workers.
 */
function getCfObject(request: Request): CfProperties | undefined {
	return (request as { cf?: CfProperties }).cf;
}

/**
 * Extract geographic information from the Cloudflare `cf` object
 * attached to the request. Returns null when not running on CF Workers.
 */
function extractGeo(cf: CfProperties | undefined): GeoInfo | null {
	if (!cf) return null;

	const country = cf.country ?? null;
	const region = cf.region ?? null;
	const city = cf.city ?? null;

	// Only return geo if at least one field is populated
	if (country === null && region === null && city === null) return null;

	return { country, region, city };
}

/**
 * Extract normalized request metadata from a Request object.
 *
 * IP resolution order:
 * 1. `CF-Connecting-IP` header — only trusted when a `cf` object is
 *    present on the request (proving the request came through Cloudflare's
 *    edge, which strips/overwrites client-supplied values).
 * 2. `X-Forwarded-For` header (first entry) — best-effort, spoofable
 *    when there is no trusted reverse proxy.
 * 3. `null`
 */
export function extractRequestMeta(request: Request): RequestMeta {
	const headers = request.headers;
	const cf = getCfObject(request);

	// IP: only trust headers when the cf object confirms we're on Cloudflare.
	// Without a trusted reverse proxy, X-Forwarded-For is trivially spoofable.
	let ip: string | null = null;
	if (cf) {
		const cfIp = headers.get("cf-connecting-ip")?.trim();
		if (cfIp && IP_PATTERN.test(cfIp)) {
			ip = cfIp;
		}
	}
	if (!ip && cf) {
		// Only trust X-Forwarded-For when we're behind Cloudflare (which
		// overwrites the header). In standalone deployments without a trusted
		// proxy, XFF is trivially spoofable.
		const xff = headers.get("x-forwarded-for");
		ip = xff ? parseFirstForwardedIp(xff) : null;
	}

	const userAgent = headers.get("user-agent")?.trim() || null;
	const referer = headers.get("referer")?.trim() || null;
	const geo = extractGeo(cf);

	return { ip, userAgent, referer, geo };
}

// =============================================================================
// Header Sanitization for Sandbox
// =============================================================================

/**
 * Headers that must never cross the RPC boundary to sandboxed plugins.
 * Session tokens, auth credentials, and infrastructure headers are stripped
 * to prevent malicious plugins from exfiltrating sensitive data.
 */
const SANDBOX_STRIPPED_HEADERS = new Set([
	"cookie",
	"set-cookie",
	"authorization",
	"proxy-authorization",
	"cf-access-jwt-assertion",
	"cf-access-client-id",
	"cf-access-client-secret",
	"x-emdash-request",
]);

/**
 * Copy request headers into a plain object, stripping sensitive headers
 * that must not be exposed to sandboxed plugin code.
 */
export function sanitizeHeadersForSandbox(headers: Headers): Record<string, string> {
	const safe: Record<string, string> = {};
	headers.forEach((value, key) => {
		if (!SANDBOX_STRIPPED_HEADERS.has(key)) {
			safe[key] = value;
		}
	});
	return safe;
}
