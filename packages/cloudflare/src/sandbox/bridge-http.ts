/**
 * HTTP fetch helper for sandboxed plugins, called from the bridge.
 *
 * The bridge's httpFetch RPC method delegates here so the logic is pure and
 * testable without standing up a real WorkerEntrypoint.
 *
 * Responsibilities:
 *  - Enforce the `network:fetch` / `network:fetch:any` capability.
 *  - Enforce the allowedHosts list, including on every redirect hop. The
 *    native `fetch` follows 3xx responses automatically; without manual
 *    redirect handling an allowed host that 302s to a disallowed host
 *    would bypass the allowlist.
 *  - Strip credential headers (Authorization, Cookie, Proxy-Authorization)
 *    on cross-origin redirects so tokens don't leak to attacker hosts.
 *  - For `network:fetch:any`, apply a minimal SSRF check on every hop so
 *    plugins can't be tricked into reaching cloud-metadata endpoints or
 *    literal private IPs even without an explicit allowlist.
 */

/** Maximum redirect chain length before we give up. */
const MAX_REDIRECTS = 5;

/** Headers that must be stripped when a redirect crosses origins. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * Known internal hostnames. Matched case-insensitively after stripping any
 * trailing dots (FQDN form) and IPv6 brackets.
 */
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata.google"]);

/**
 * Wildcard DNS services commonly used by SSRF tooling to map hostnames to
 * private IPs (e.g. 127.0.0.1.nip.io -> 127.0.0.1). Matched as a suffix.
 */
const BLOCKED_HOSTNAME_SUFFIXES = [
	"nip.io",
	"sslip.io",
	"xip.io",
	"traefik.me",
	"lvh.me",
	"localtest.me",
	// RFC 6761 §6.3 — any subdomain of localhost must resolve to loopback.
	// The apex is already in BLOCKED_HOSTNAMES, this catches *.localhost.
	"localhost",
];

/** RFC1918, loopback, link-local, current-network IPv4 ranges. */
const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
	[ip4(127, 0, 0, 0), ip4(127, 255, 255, 255)],
	[ip4(10, 0, 0, 0), ip4(10, 255, 255, 255)],
	[ip4(172, 16, 0, 0), ip4(172, 31, 255, 255)],
	[ip4(192, 168, 0, 0), ip4(192, 168, 255, 255)],
	[ip4(169, 254, 0, 0), ip4(169, 254, 255, 255)],
	[ip4(0, 0, 0, 0), ip4(0, 255, 255, 255)],
];

function ip4(a: number, b: number, c: number, d: number): number {
	return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Match IPv6 brackets at start/end for stripping. */
const IPV6_BRACKET_PATTERN = /^\[|\]$/g;

/** Match any number of trailing dots on an FQDN for stripping. */
const TRAILING_DOT_PATTERN = /\.+$/;

/** Match fc00::/7 ULA addresses — first byte 0xfc or 0xfd followed by any byte. */
const IPV6_ULA_FC_PATTERN = /^fc[0-9a-f]{2}:/;
const IPV6_ULA_FD_PATTERN = /^fd[0-9a-f]{2}:/;

/**
 * IPv4-mapped IPv6 in hex form: ::ffff:XXXX:XXXX
 * The WHATWG URL parser normalises dotted-decimal to hex:
 *   [::ffff:127.0.0.1]       -> [::ffff:7f00:1]
 *   [::ffff:169.254.169.254] -> [::ffff:a9fe:a9fe]
 * Without converting back, the hex form bypasses the IPv4 range check.
 */
const IPV4_MAPPED_IPV6_HEX_PATTERN = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** URL schemes we allow for outbound plugin fetches. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function parseIpv4(ip: string): number | null {
	const m = IPV4_PATTERN.exec(ip);
	if (!m) return null;
	const parts = [m[1], m[2], m[3], m[4]].map((x) => Number(x));
	if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
	return ip4(parts[0]!, parts[1]!, parts[2]!, parts[3]!);
}

/**
 * Convert a hex-form IPv4-mapped IPv6 address back to dotted-decimal IPv4.
 * Returns null if the input isn't in the hex-mapped form.
 */
function normalizeIPv4MappedIPv6(ip: string): string | null {
	const match = IPV4_MAPPED_IPV6_HEX_PATTERN.exec(ip);
	if (!match) return null;
	const high = parseInt(match[1]!, 16);
	const low = parseInt(match[2]!, 16);
	return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isPrivateLiteral(hostname: string): boolean {
	// Strip IPv6 brackets
	const bare = hostname.replace(IPV6_BRACKET_PATTERN, "").toLowerCase();
	if (bare === "::1" || bare === "::ffff:127.0.0.1") return true;

	// IPv4-mapped IPv6 in hex form (what WHATWG produces for [::ffff:127.0.0.1])
	const mapped = normalizeIPv4MappedIPv6(bare);
	if (mapped !== null) {
		const num = parseIpv4(mapped);
		if (num !== null) {
			return BLOCKED_IPV4_RANGES.some(([start, end]) => num >= start && num <= end);
		}
	}

	const num = parseIpv4(bare);
	if (num !== null) {
		return BLOCKED_IPV4_RANGES.some(([start, end]) => num >= start && num <= end);
	}

	// Loose IPv6 link-local / ULA detection. The bridge leaves full DNS
	// resolution to the platform; we only need to catch literal addresses
	// here. Anything containing a colon and matching one of these prefixes
	// is private.
	if (bare.includes(":")) {
		return (
			bare.startsWith("fe80:") || IPV6_ULA_FC_PATTERN.test(bare) || IPV6_ULA_FD_PATTERN.test(bare)
		);
	}
	return false;
}

function isBlockedHostname(hostname: string): boolean {
	// Strip brackets + trailing dots + lowercase. Trailing-dot FQDNs (e.g.
	// "localhost.") are preserved by the WHATWG URL parser, so without
	// normalisation they'd bypass exact-match checks.
	const normalised = hostname
		.replace(IPV6_BRACKET_PATTERN, "")
		.replace(TRAILING_DOT_PATTERN, "")
		.toLowerCase();

	if (BLOCKED_HOSTNAMES.has(normalised)) return true;
	for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
		if (normalised === suffix || normalised.endsWith(`.${suffix}`)) return true;
	}
	return false;
}

/**
 * Check if a hostname matches any pattern in the allowlist.
 * Patterns: "*" matches all, "*.example.com" matches subdomains AND the bare
 * apex, and any other string matches exactly.
 *
 * Both host and patterns are normalised (lowercase + trailing dots stripped)
 * so "API.Example.com" in a manifest and "api.example.com." on a request
 * still match.
 */
function isHostAllowed(host: string, allowedHosts: string[]): boolean {
	const normHost = host.replace(TRAILING_DOT_PATTERN, "").toLowerCase();
	return allowedHosts.some((pattern) => {
		const p = pattern.replace(TRAILING_DOT_PATTERN, "").toLowerCase();
		if (p === "*") return true;
		if (p.startsWith("*.")) {
			const suffix = p.slice(1);
			return normHost.endsWith(suffix) || normHost === p.slice(2);
		}
		return normHost === p;
	});
}

/** Return a copy of init with credential headers removed. */
function stripCredentialHeaders(init: RequestInit): RequestInit {
	if (!init.headers) return init;
	const headers = new Headers(init.headers);
	for (const name of CREDENTIAL_HEADERS) {
		headers.delete(name);
	}
	return { ...init, headers };
}

export interface SandboxHttpFetchOptions {
	capabilities: string[];
	allowedHosts: string[];
	/** Injectable fetch for tests. Defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
}

export interface SandboxHttpFetchResult {
	status: number;
	headers: Record<string, string>;
	text: string;
}

/**
 * Fetch a URL on behalf of a sandboxed plugin with manual redirect handling.
 *
 * @throws Error if the capability is missing, a host isn't allowed, or the
 *   target resolves to a known-internal address.
 */
export async function sandboxHttpFetch(
	url: string,
	init: RequestInit | undefined,
	options: SandboxHttpFetchOptions,
): Promise<SandboxHttpFetchResult> {
	const { capabilities, allowedHosts } = options;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	const hasUnrestricted = capabilities.includes("network:fetch:any");
	const hasFetch = capabilities.includes("network:fetch") || hasUnrestricted;
	if (!hasFetch) {
		throw new Error("Missing capability: network:fetch");
	}

	if (!hasUnrestricted && allowedHosts.length === 0) {
		throw new Error(
			"Plugin has no allowed hosts configured. Add hosts to allowedHosts to enable HTTP requests.",
		);
	}

	let currentUrl = url;
	let currentInit: RequestInit | undefined = init;

	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		const parsed = new URL(currentUrl);
		const hostname = parsed.hostname;

		// Only http(s) is allowed. Keeps file:, data:, ftp:, and friends out
		// regardless of what the platform fetch happens to support.
		if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
			throw new Error(`Unsupported scheme: ${parsed.protocol}`);
		}

		// Literal-IP / internal-hostname SSRF check runs on every request,
		// including the restricted (allowedHosts) path. The allowlist scopes
		// which public hosts a plugin may reach — it must not be a way to
		// opt out of SSRF protection (e.g. `allowedHosts: ["*"]` does NOT
		// grant access to 127.0.0.1).
		if (isPrivateLiteral(hostname) || isBlockedHostname(hostname)) {
			throw new Error(`Blocked fetch to internal host: ${hostname}`);
		}

		if (!hasUnrestricted && !isHostAllowed(hostname, allowedHosts)) {
			throw new Error(`Host not allowed: ${hostname}`);
		}

		const response = await fetchImpl(currentUrl, {
			...currentInit,
			redirect: "manual",
		});

		// Not a redirect — return directly.
		if (response.status < 300 || response.status >= 400) {
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});
			return {
				status: response.status,
				headers,
				text: await response.text(),
			};
		}

		const location = response.headers.get("Location");
		if (!location) {
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});
			return {
				status: response.status,
				headers,
				text: await response.text(),
			};
		}

		// Resolve relative redirects; strip credentials on cross-origin hops.
		const previousOrigin = parsed.origin;
		currentUrl = new URL(location, currentUrl).href;
		const nextOrigin = new URL(currentUrl).origin;
		if (previousOrigin !== nextOrigin && currentInit) {
			currentInit = stripCredentialHeaders(currentInit);
		}
	}

	throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}
