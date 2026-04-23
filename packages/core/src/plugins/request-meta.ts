/**
 * Request Metadata Extraction
 *
 * Extracts normalized metadata (IP, user agent, referer, geo) from
 * incoming requests. Used by plugin route handlers to access request
 * context without touching raw headers.
 *
 */

import type { EmDashConfig } from "../astro/integration/runtime.js";
import { getTrustedProxyHeaders } from "../auth/trusted-proxy.js";
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
 * Read an IP from an operator-declared trusted header. XFF-style headers
 * (any name ending in `forwarded-for`) are parsed as comma-separated lists
 * and the first entry is used; everything else is treated as a single
 * trimmed value.
 */
function readIpFromHeader(headers: Headers, name: string): string | null {
	const value = headers.get(name);
	if (!value) return null;
	if (name.endsWith("forwarded-for")) {
		return parseFirstForwardedIp(value);
	}
	const trimmed = value.trim();
	if (!trimmed) return null;
	return IP_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Get the Cloudflare `cf` object from the request, if present.
 * Returns undefined when not running on Cloudflare Workers.
 */
function getCfObject(request: Request): CfProperties | undefined {
	return (request as unknown as { cf?: CfProperties }).cf;
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
 * 1. `CF-Connecting-IP` — trusted only when a `cf` object is present on the
 *    request. CF edge overwrites any client-supplied value, so this is the
 *    cryptographically trustworthy path on Workers. Operator-declared
 *    trusted headers cannot override it.
 * 2. `X-Forwarded-For` first entry — trusted only with a `cf` object.
 * 3. Operator-declared trusted proxy headers (from `config.trustedProxyHeaders`
 *    or the `EMDASH_TRUSTED_PROXY_HEADERS` env var), tried in order. Used as
 *    the primary source off-CF and as a fill-in on CF.
 * 4. `null`
 *
 * The second argument accepts either the EmDash config or a pre-resolved
 * list of trusted headers, so callers that already have the list don't have
 * to round-trip through the config every request.
 */
export function extractRequestMeta(
	request: Request,
	configOrTrustedHeaders?: EmDashConfig | null | { trustedProxyHeaders?: string[] } | string[],
): RequestMeta {
	const headers = request.headers;
	const cf = getCfObject(request);
	const trusted = resolveTrustedHeaders(configOrTrustedHeaders);

	let ip: string | null = null;

	// On Cloudflare, prefer the cryptographically trustworthy headers first.
	if (cf) {
		const cfIp = headers.get("cf-connecting-ip")?.trim();
		if (cfIp && IP_PATTERN.test(cfIp)) {
			ip = cfIp;
		}
		if (!ip) {
			const xff = headers.get("x-forwarded-for");
			ip = xff ? parseFirstForwardedIp(xff) : null;
		}
	}

	// Fall through to operator-declared trusted headers. On CF this fills
	// in when the CF headers are absent; off-CF it's the primary source.
	if (!ip) {
		for (const name of trusted) {
			const value = readIpFromHeader(headers, name);
			if (value) {
				ip = value;
				break;
			}
		}
	}

	const userAgent = headers.get("user-agent")?.trim() || null;
	const referer = headers.get("referer")?.trim() || null;
	const geo = extractGeo(cf);

	return { ip, userAgent, referer, geo };
}

function resolveTrustedHeaders(
	value: EmDashConfig | null | { trustedProxyHeaders?: string[] } | string[] | undefined,
): string[] {
	if (Array.isArray(value)) {
		return value.map((h) => h.toLowerCase());
	}
	return getTrustedProxyHeaders(value);
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
