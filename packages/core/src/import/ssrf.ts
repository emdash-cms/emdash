/**
 * SSRF protection for import URLs.
 *
 * Validates that URLs don't target internal/private network addresses.
 * Applied before any fetch() call in the import pipeline.
 */

const IPV4_MAPPED_IPV6_DOTTED_PATTERN = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const IPV4_MAPPED_IPV6_HEX_PATTERN = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
const IPV4_TRANSLATED_HEX_PATTERN = /^::ffff:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
const IPV6_EXPANDED_MAPPED_PATTERN =
	/^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/**
 * IPv4-compatible (deprecated) addresses: ::XXXX:XXXX
 *
 * The WHATWG URL parser normalizes [::127.0.0.1] to [::7f00:1] (no ffff prefix).
 * These are deprecated but still parsed, and bypass the ffff-based checks.
 */
const IPV4_COMPATIBLE_HEX_PATTERN = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/**
 * NAT64 prefix (RFC 6052): 64:ff9b::XXXX:XXXX
 *
 * Used by NAT64 gateways to embed IPv4 addresses in IPv6.
 * [64:ff9b::127.0.0.1] normalizes to [64:ff9b::7f00:1].
 */
const NAT64_HEX_PATTERN = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

const IPV6_BRACKET_PATTERN = /^\[|\]$/g;

/** Match fc00::/7 ULA — first byte 0xfc or 0xfd followed by any byte. */
const IPV6_ULA_FC_PATTERN = /^fc[0-9a-f]{2}:/;
const IPV6_ULA_FD_PATTERN = /^fd[0-9a-f]{2}:/;

/** Strip trailing dots from an FQDN-form hostname ("localhost." -> "localhost"). */
const TRAILING_DOT_PATTERN = /\.+$/;

/**
 * Private and reserved IP ranges that should never be fetched.
 *
 * Includes:
 * - Loopback (127.0.0.0/8)
 * - Private (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Link-local (169.254.0.0/16)
 * - Cloud metadata (169.254.169.254 — AWS/GCP/Azure)
 * - IPv6 loopback and link-local
 */
const BLOCKED_PATTERNS: Array<{ start: number; end: number }> = [
	// 127.0.0.0/8 — loopback
	{ start: ip4ToNum(127, 0, 0, 0), end: ip4ToNum(127, 255, 255, 255) },
	// 10.0.0.0/8 — private
	{ start: ip4ToNum(10, 0, 0, 0), end: ip4ToNum(10, 255, 255, 255) },
	// 172.16.0.0/12 — private
	{ start: ip4ToNum(172, 16, 0, 0), end: ip4ToNum(172, 31, 255, 255) },
	// 192.168.0.0/16 — private
	{ start: ip4ToNum(192, 168, 0, 0), end: ip4ToNum(192, 168, 255, 255) },
	// 169.254.0.0/16 — link-local (includes cloud metadata endpoint)
	{ start: ip4ToNum(169, 254, 0, 0), end: ip4ToNum(169, 254, 255, 255) },
	// 0.0.0.0/8 — current network
	{ start: ip4ToNum(0, 0, 0, 0), end: ip4ToNum(0, 255, 255, 255) },
];

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"metadata.google.internal",
	"metadata.google",
	"[::1]",
]);

/**
 * Wildcard DNS services that publicly resolve arbitrary IPs embedded in the
 * hostname. Commonly used in local dev and by SSRF exploit tooling to bypass
 * hostname-only blocklists (e.g. 127.0.0.1.nip.io -> 127.0.0.1).
 *
 * Matched case-insensitively as a suffix, so both the apex and any subdomain
 * are blocked.
 */
const BLOCKED_HOSTNAME_SUFFIXES = [
	"nip.io",
	"sslip.io",
	"xip.io",
	"traefik.me",
	"lvh.me",
	"localtest.me",
];

/** Blocked URL schemes */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function ip4ToNum(a: number, b: number, c: number, d: number): number {
	return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseIpv4(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;

	const nums = parts.map(Number);
	if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return null;

	return ip4ToNum(nums[0], nums[1], nums[2], nums[3]);
}

/**
 * Convert IPv4-mapped/translated IPv6 addresses from hex form back to IPv4.
 *
 * The WHATWG URL parser normalizes dotted-decimal to hex:
 *   [::ffff:127.0.0.1] -> [::ffff:7f00:1]
 *   [::ffff:169.254.169.254] -> [::ffff:a9fe:a9fe]
 *
 * Without this conversion, the hex forms bypass isPrivateIp() regex checks.
 */
export function normalizeIPv6MappedToIPv4(ip: string): string | null {
	// Match hex-form IPv4-mapped IPv6: ::ffff:XXXX:XXXX
	let match = ip.match(IPV4_MAPPED_IPV6_HEX_PATTERN);
	if (!match) {
		// Match IPv4-translated (RFC 6052): ::ffff:0:XXXX:XXXX
		match = ip.match(IPV4_TRANSLATED_HEX_PATTERN);
	}
	if (!match) {
		// Match fully expanded form: 0000:0000:0000:0000:0000:ffff:XXXX:XXXX
		match = ip.match(IPV6_EXPANDED_MAPPED_PATTERN);
	}
	if (!match) {
		// Match IPv4-compatible (deprecated) form: ::XXXX:XXXX (no ffff prefix)
		match = ip.match(IPV4_COMPATIBLE_HEX_PATTERN);
	}
	if (!match) {
		// Match NAT64 prefix (RFC 6052): 64:ff9b::XXXX:XXXX
		match = ip.match(NAT64_HEX_PATTERN);
	}
	if (match) {
		const high = parseInt(match[1] ?? "", 16);
		const low = parseInt(match[2] ?? "", 16);
		return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
	}
	return null;
}

function isPrivateIp(ip: string): boolean {
	// Normalize IPv6 strings to lowercase. `new URL().hostname` already
	// lowercases, but resolver output (from DoH or an injected resolver) may
	// not. Without this, "FE80::1" bypasses the link-local check.
	const normalized = ip.toLowerCase();

	// Handle IPv6 loopback
	if (normalized === "::1" || normalized === "::ffff:127.0.0.1") return true;

	// Handle IPv4-mapped IPv6 in hex form (WHATWG URL parser normalizes to this)
	// e.g. ::ffff:7f00:1 -> 127.0.0.1, ::ffff:a9fe:a9fe -> 169.254.169.254
	const hexIpv4 = normalizeIPv6MappedToIPv4(normalized);
	if (hexIpv4) return isPrivateIp(hexIpv4);

	// Handle IPv4-mapped IPv6 in dotted-decimal form
	const v4Match = normalized.match(IPV4_MAPPED_IPV6_DOTTED_PATTERN);
	const ipv4 = v4Match ? v4Match[1] : normalized;

	const num = parseIpv4(ipv4);
	if (num === null) {
		// If we can't parse it, block IPv6 addresses that look internal.
		// fc00::/7 is Unique Local (first byte 0xfc or 0xfd), fe80::/10 is
		// link-local. Only match when followed by hex digit + colon to avoid
		// collisions with hypothetical non-address strings.
		return (
			normalized.startsWith("fe80:") ||
			IPV6_ULA_FC_PATTERN.test(normalized) ||
			IPV6_ULA_FD_PATTERN.test(normalized)
		);
	}

	return BLOCKED_PATTERNS.some((range) => num >= range.start && num <= range.end);
}

/**
 * Error thrown when SSRF protection blocks a URL.
 */
export class SsrfError extends Error {
	code = "SSRF_BLOCKED" as const;

	constructor(message: string) {
		super(message);
		this.name = "SsrfError";
	}
}

/**
 * Validate that a URL is safe to fetch (not targeting internal networks).
 *
 * Checks:
 * 1. URL is well-formed with http/https scheme
 * 2. Hostname is not a known internal name (localhost, metadata endpoints)
 * 3. If hostname is an IP literal, it's not in a private range
 *
 * Note: DNS rebinding attacks are not fully mitigated (hostname could resolve
 * to a private IP). Full protection requires resolving DNS and checking the IP
 * before connecting, which needs a custom fetch implementation. This covers
 * the most common SSRF vectors.
 *
 * @throws SsrfError if the URL targets an internal address
 */
/** Maximum number of redirects to follow in ssrfSafeFetch */
const MAX_REDIRECTS = 5;

export function validateExternalUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new SsrfError("Invalid URL");
	}

	// Only allow http/https
	if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
		throw new SsrfError(`Scheme '${parsed.protocol}' is not allowed`);
	}

	// Strip brackets from IPv6 hostname
	const hostname = parsed.hostname.replace(IPV6_BRACKET_PATTERN, "");

	// Normalize the hostname for blocklist matching: lowercase + strip any
	// trailing dots. WHATWG preserves trailing dots on .hostname, so without
	// this normalization "localhost." and "nip.io." bypass the checks.
	const normalizedHost = hostname.toLowerCase().replace(TRAILING_DOT_PATTERN, "");

	// Check against known internal hostnames
	if (BLOCKED_HOSTNAMES.has(normalizedHost)) {
		throw new SsrfError("URLs targeting internal hosts are not allowed");
	}

	// Check against wildcard DNS services used by SSRF tooling to bypass
	// hostname-only checks. Match the apex and any subdomain.
	for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
		if (normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`)) {
			throw new SsrfError("URLs targeting wildcard DNS services are not allowed");
		}
	}

	// Check if hostname is an IP address in a private range
	if (isPrivateIp(hostname)) {
		throw new SsrfError("URLs targeting private IP addresses are not allowed");
	}

	return parsed;
}

// ---------------------------------------------------------------------------
// DNS-aware validation
// ---------------------------------------------------------------------------

/**
 * A resolver that maps a hostname to a list of IPv4/IPv6 addresses.
 * Injectable so callers can swap in OS-level DNS on Node, stub it in tests,
 * or point to a different DoH endpoint.
 */
export type DnsResolver = (hostname: string) => Promise<string[]>;

/**
 * Module-level default resolver. Tests can swap this with a stub so fetch
 * mocks don't see unexpected DoH round-trips. Production code should leave
 * it alone.
 */
let defaultResolver: DnsResolver | null = null;

/** Override the default DNS resolver. Returns the previous value. */
export function setDefaultDnsResolver(resolver: DnsResolver | null): DnsResolver | null {
	const previous = defaultResolver;
	defaultResolver = resolver;
	return previous;
}

/** Timeout for a single DoH request, in milliseconds. */
const DOH_TIMEOUT_MS = 3000;

/** Default DoH endpoint — Cloudflare's public resolver. */
const DEFAULT_DOH_URL = "https://cloudflare-dns.com/dns-query";

interface DohAnswer {
	data: string;
}

interface DohResponse {
	Status: number;
	Answer: DohAnswer[];
}

function hasProperty<K extends string>(obj: unknown, key: K): obj is Record<K, unknown> {
	return typeof obj === "object" && obj !== null && key in obj;
}

/**
 * Narrow an unknown JSON body to a DohResponse shape we can read safely.
 * Throws if the body doesn't look like a DoH response — a malformed body is
 * indistinguishable from a failure and must not be silently treated as empty.
 */
function parseDohResponse(raw: unknown): DohResponse {
	if (!hasProperty(raw, "Status") || typeof raw.Status !== "number") {
		throw new Error("DoH response missing Status field");
	}
	const answers: DohAnswer[] = [];
	if (hasProperty(raw, "Answer") && Array.isArray(raw.Answer)) {
		for (const entry of raw.Answer) {
			if (hasProperty(entry, "data") && typeof entry.data === "string") {
				answers.push({ data: entry.data });
			}
		}
	}
	return { Status: raw.Status, Answer: answers };
}

/**
 * Resolve a hostname via DNS over HTTPS (Cloudflare). Returns all A and AAAA
 * records. Works in both Workers and Node without requiring node:dns.
 *
 * Fails closed: any network error, non-2xx response, or DNS rcode != 0
 * causes a rejected promise so the calling validator treats it as a block.
 */
export const cloudflareDohResolver: DnsResolver = async (hostname) => {
	async function query(type: "A" | "AAAA"): Promise<string[]> {
		const params = new URLSearchParams({ name: hostname, type });
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
		try {
			const response = await globalThis.fetch(`${DEFAULT_DOH_URL}?${params.toString()}`, {
				headers: { Accept: "application/dns-json" },
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`DoH lookup failed: ${response.status}`);
			}
			const raw = await response.json();
			const body = parseDohResponse(raw);
			// NXDOMAIN (3) is a legitimate "does not exist" — treat as empty.
			// Any other non-zero status (SERVFAIL=2, REFUSED=5, etc.) is
			// ambiguous and could be a split-view attacker hiding records
			// from our resolver. Fail closed.
			if (body.Status === 3) return [];
			if (body.Status !== 0) {
				throw new Error(`DoH ${type} lookup failed: rcode=${body.Status}`);
			}
			return body.Answer.map((a) => a.data).filter((d) => typeof d === "string");
		} finally {
			clearTimeout(timeout);
		}
	}

	const [a, aaaa] = await Promise.all([query("A"), query("AAAA")]);
	return [...a, ...aaaa];
};

/**
 * Validate a URL and resolve its hostname to check the actual IPs against
 * the private-range blocklist. This catches DNS rebinding attacks using
 * attacker-controlled domains that publicly resolve to private addresses,
 * and wildcard DNS services like nip.io used by exploit tooling.
 *
 * Runs `validateExternalUrl` first for cheap pre-flight checks (scheme,
 * literal IP, known-bad hostnames). Then resolves the hostname and rejects
 * if ANY returned address is private.
 *
 * Fails closed: if resolution fails or returns no records, throws SsrfError.
 *
 * **Caveats.** This does NOT fully close the TOCTOU between check and
 * connect. Attacks that still work against this layer include:
 *
 * - TTL=0 rebind: authoritative server returns public IP to the check, then
 *   private IP to the subsequent fetch() a few milliseconds later.
 * - Split-view via EDNS Client Subnet or source-IP inspection: the
 *   authoritative server returns public IP to Cloudflare's DoH resolver and
 *   private IP to the victim's own resolver (used by fetch()).
 * - Host-file overrides or split-horizon corporate DNS on self-hosted Node.
 * - Attacker-controlled rebinding services the caller has allowlisted.
 *
 * The only complete defense is a network-layer egress firewall. On
 * Cloudflare Workers, the platform fetch pipeline provides most of that.
 * On self-hosted Node, operators must restrict egress themselves.
 */
export async function resolveAndValidateExternalUrl(
	url: string,
	options?: { resolver?: DnsResolver },
): Promise<URL> {
	const parsed = validateExternalUrl(url);

	// Strip brackets from IPv6 hostnames
	const hostname = parsed.hostname.replace(IPV6_BRACKET_PATTERN, "");

	// If the hostname is already an IP literal, validateExternalUrl has
	// already checked it against the private-range list. Skip DNS.
	if (isIpLiteral(hostname)) {
		return parsed;
	}

	const resolver = options?.resolver ?? defaultResolver ?? cloudflareDohResolver;

	let addresses: string[];
	try {
		addresses = await resolver(hostname);
	} catch (error) {
		throw new SsrfError(
			`Could not resolve hostname: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (addresses.length === 0) {
		throw new SsrfError("Hostname resolved to no addresses");
	}

	for (const ip of addresses) {
		if (isPrivateIp(ip)) {
			throw new SsrfError("Hostname resolves to a private IP address");
		}
	}

	return parsed;
}

/** True when a string looks like an IPv4 or IPv6 literal. */
function isIpLiteral(host: string): boolean {
	if (parseIpv4(host) !== null) return true;
	// Very loose IPv6 heuristic — matches anything with a colon, which is
	// never valid in DNS hostnames, so this is safe.
	return host.includes(":");
}

/**
 * Fetch a URL with SSRF protection on redirects.
 *
 * Uses `redirect: "manual"` to intercept redirects and re-validate each
 * redirect target against SSRF rules before following it. This prevents
 * an attacker from setting up an allowed external URL that redirects to
 * an internal IP (e.g. 169.254.169.254 for cloud metadata).
 *
 * @throws SsrfError if the initial URL or any redirect target is internal
 */
/** Headers that must be stripped when a redirect crosses origins */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

export async function ssrfSafeFetch(
	url: string,
	init?: RequestInit,
	options?: { resolver?: DnsResolver },
): Promise<Response> {
	let currentUrl = url;
	let currentInit = init;

	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		await resolveAndValidateExternalUrl(currentUrl, options);

		const response = await globalThis.fetch(currentUrl, {
			...currentInit,
			redirect: "manual",
		});

		// Not a redirect -- return directly
		if (response.status < 300 || response.status >= 400) {
			return response;
		}

		// Extract redirect target
		const location = response.headers.get("Location");
		if (!location) {
			return response;
		}

		// Resolve relative redirects against the current URL
		const previousOrigin = new URL(currentUrl).origin;
		currentUrl = new URL(location, currentUrl).href;
		const nextOrigin = new URL(currentUrl).origin;

		// Strip credential headers on cross-origin redirects
		if (previousOrigin !== nextOrigin && currentInit) {
			currentInit = stripCredentialHeaders(currentInit);
		}
	}

	throw new SsrfError(`Too many redirects (max ${MAX_REDIRECTS})`);
}

/**
 * Return a copy of init with credential headers removed.
 */
export function stripCredentialHeaders(init: RequestInit): RequestInit {
	if (!init.headers) return init;

	const headers = new Headers(init.headers);
	for (const name of CREDENTIAL_HEADERS) {
		headers.delete(name);
	}

	return { ...init, headers };
}
