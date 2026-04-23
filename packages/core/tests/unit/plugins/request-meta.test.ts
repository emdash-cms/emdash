/**
 * Request Metadata Extraction Tests
 *
 * Tests for extractRequestMeta():
 * - IP resolution: CF-Connecting-IP (only with cf object), X-Forwarded-For fallback, null
 * - IP validation: rejects non-IP values (XSS payloads, garbage)
 * - Geo extraction from Cloudflare `cf` object on request
 * - User agent and referer header reads (trimmed)
 * - IPv6 support
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetTrustedProxyHeadersCache } from "../../../src/auth/trusted-proxy.js";
import {
	extractRequestMeta,
	sanitizeHeadersForSandbox,
} from "../../../src/plugins/request-meta.js";

// Keep the env-derived trusted-header cache from leaking between tests
// (and between this file and others in the same vitest worker).
const ORIGINAL_TRUSTED_ENV = process.env.EMDASH_TRUSTED_PROXY_HEADERS;
beforeEach(() => {
	delete process.env.EMDASH_TRUSTED_PROXY_HEADERS;
	_resetTrustedProxyHeadersCache();
});
afterEach(() => {
	if (ORIGINAL_TRUSTED_ENV === undefined) {
		delete process.env.EMDASH_TRUSTED_PROXY_HEADERS;
	} else {
		process.env.EMDASH_TRUSTED_PROXY_HEADERS = ORIGINAL_TRUSTED_ENV;
	}
	_resetTrustedProxyHeadersCache();
});

/**
 * Helper to create a Request with optional headers and cf properties.
 */
function createRequest(
	opts: {
		headers?: Record<string, string>;
		cf?: { country?: string; region?: string; city?: string };
	} = {},
): Request {
	const req = new Request("http://localhost/test", {
		headers: opts.headers,
	});

	// Attach cf object if provided (simulates Cloudflare Workers runtime)
	if (opts.cf) {
		(req as unknown as { cf: typeof opts.cf }).cf = opts.cf;
	}

	return req;
}

describe("extractRequestMeta", () => {
	describe("IP resolution", () => {
		it("trusts CF-Connecting-IP when cf object is present", () => {
			const req = createRequest({
				headers: {
					"cf-connecting-ip": "1.2.3.4",
					"x-forwarded-for": "5.6.7.8, 9.10.11.12",
				},
				cf: { country: "US" },
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBe("1.2.3.4");
		});

		it("ignores CF-Connecting-IP and XFF when no cf object (spoofed headers)", () => {
			const req = createRequest({
				headers: {
					"cf-connecting-ip": "1.2.3.4",
					"x-forwarded-for": "5.6.7.8, 9.10.11.12",
				},
				// No cf object — not on Cloudflare, XFF is untrusted
			});

			const meta = extractRequestMeta(req);
			// Neither CF-Connecting-IP nor XFF should be trusted without cf object
			expect(meta.ip).toBeNull();
		});

		it("returns null when CF-Connecting-IP is spoofed and no XFF", () => {
			const req = createRequest({
				headers: {
					"cf-connecting-ip": "1.2.3.4",
				},
				// No cf object
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBeNull();
		});

		it("falls back to X-Forwarded-For when behind Cloudflare (cf object present)", () => {
			const req = createRequest({
				headers: {
					"x-forwarded-for": "5.6.7.8, 9.10.11.12",
				},
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBe("5.6.7.8");
		});

		it("ignores X-Forwarded-For without cf object (standalone deployment)", () => {
			const req = createRequest({
				headers: {
					"x-forwarded-for": "5.6.7.8, 9.10.11.12",
				},
				// No cf object — standalone deployment, XFF is spoofable
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBeNull();
		});

		it("handles single IP in X-Forwarded-For with cf object", () => {
			const req = createRequest({
				headers: {
					"x-forwarded-for": "5.6.7.8",
				},
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBe("5.6.7.8");
		});

		it("trims whitespace from X-Forwarded-For entries", () => {
			const req = createRequest({
				headers: {
					"x-forwarded-for": "  5.6.7.8  , 9.10.11.12",
				},
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBe("5.6.7.8");
		});

		it("trims whitespace from CF-Connecting-IP", () => {
			const req = createRequest({
				headers: {
					"cf-connecting-ip": "  1.2.3.4  ",
				},
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBe("1.2.3.4");
		});

		it("returns null when no IP headers present", () => {
			const req = createRequest();

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBeNull();
		});

		it("returns null for empty CF-Connecting-IP with no X-Forwarded-For", () => {
			const req = createRequest({
				headers: {
					"cf-connecting-ip": "",
				},
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBeNull();
		});

		it("falls back to X-Forwarded-For when CF-Connecting-IP is empty", () => {
			const req = createRequest({
				headers: {
					"cf-connecting-ip": "",
					"x-forwarded-for": "5.6.7.8",
				},
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBe("5.6.7.8");
		});
	});

	describe("IPv6 support", () => {
		it("handles IPv6 loopback in X-Forwarded-For with cf object", () => {
			const req = createRequest({
				headers: { "x-forwarded-for": "::1" },
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBe("::1");
		});

		it("handles full IPv6 address in X-Forwarded-For with cf object", () => {
			const req = createRequest({
				headers: { "x-forwarded-for": "2001:db8::1, 10.0.0.1" },
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBe("2001:db8::1");
		});

		it("handles IPv6 in CF-Connecting-IP with cf object", () => {
			const req = createRequest({
				headers: { "cf-connecting-ip": "2001:db8:85a3::8a2e:370:7334" },
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBe("2001:db8:85a3::8a2e:370:7334");
		});
	});

	describe("IP validation", () => {
		it("rejects XSS payload in X-Forwarded-For", () => {
			const req = createRequest({
				headers: { "x-forwarded-for": "<script>alert(1)</script>" },
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBeNull();
		});

		it("rejects non-IP text in X-Forwarded-For", () => {
			const req = createRequest({
				headers: { "x-forwarded-for": "not-an-ip, 1.2.3.4" },
				cf: {},
			});

			const meta = extractRequestMeta(req);
			// First entry is "not-an-ip" which fails validation
			expect(meta.ip).toBeNull();
		});

		it("rejects XSS payload in CF-Connecting-IP", () => {
			const req = createRequest({
				headers: { "cf-connecting-ip": "<img onerror=alert(1)>" },
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBeNull();
		});

		it("rejects empty-looking IP values with only whitespace", () => {
			const req = createRequest({
				headers: { "x-forwarded-for": "   " },
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.ip).toBeNull();
		});
	});

	describe("geo extraction", () => {
		it("extracts geo from cf object", () => {
			const req = createRequest({
				cf: { country: "US", region: "CA", city: "San Francisco" },
			});

			const meta = extractRequestMeta(req);
			expect(meta.geo).toEqual({
				country: "US",
				region: "CA",
				city: "San Francisco",
			});
		});

		it("returns null geo when no cf object", () => {
			const req = createRequest();

			const meta = extractRequestMeta(req);
			expect(meta.geo).toBeNull();
		});

		it("handles partial geo data", () => {
			const req = createRequest({
				cf: { country: "GB" },
			});

			const meta = extractRequestMeta(req);
			expect(meta.geo).toEqual({
				country: "GB",
				region: null,
				city: null,
			});
		});

		it("returns null geo when cf object has no geo fields", () => {
			const req = createRequest({
				cf: {},
			});

			const meta = extractRequestMeta(req);
			expect(meta.geo).toBeNull();
		});
	});

	describe("user agent", () => {
		it("extracts user agent from header", () => {
			const req = createRequest({
				headers: {
					"user-agent": "Mozilla/5.0 (Test)",
				},
			});

			const meta = extractRequestMeta(req);
			expect(meta.userAgent).toBe("Mozilla/5.0 (Test)");
		});

		it("returns null when no user agent header", () => {
			const req = createRequest();

			const meta = extractRequestMeta(req);
			expect(meta.userAgent).toBeNull();
		});

		it("returns null for empty user agent header", () => {
			const req = createRequest({
				headers: { "user-agent": "" },
			});

			const meta = extractRequestMeta(req);
			expect(meta.userAgent).toBeNull();
		});

		it("trims whitespace from user agent", () => {
			const req = createRequest({
				headers: { "user-agent": "  TestBot/1.0  " },
			});

			const meta = extractRequestMeta(req);
			expect(meta.userAgent).toBe("TestBot/1.0");
		});
	});

	describe("referer", () => {
		it("extracts referer from header", () => {
			const req = createRequest({
				headers: {
					referer: "https://example.com/page",
				},
			});

			const meta = extractRequestMeta(req);
			expect(meta.referer).toBe("https://example.com/page");
		});

		it("returns null when no referer header", () => {
			const req = createRequest();

			const meta = extractRequestMeta(req);
			expect(meta.referer).toBeNull();
		});

		it("returns null for empty referer header", () => {
			const req = createRequest({
				headers: { referer: "" },
			});

			const meta = extractRequestMeta(req);
			expect(meta.referer).toBeNull();
		});

		it("trims whitespace from referer", () => {
			const req = createRequest({
				headers: { referer: "  https://example.com  " },
			});

			const meta = extractRequestMeta(req);
			expect(meta.referer).toBe("https://example.com");
		});
	});

	describe("sanitizeHeadersForSandbox", () => {
		it("strips cookie header", () => {
			const headers = new Headers({ cookie: "session=abc123", "content-type": "text/html" });
			const result = sanitizeHeadersForSandbox(headers);
			expect(result).not.toHaveProperty("cookie");
			expect(result["content-type"]).toBe("text/html");
		});

		it("strips set-cookie header", () => {
			const headers = new Headers({ "set-cookie": "token=xyz", accept: "application/json" });
			const result = sanitizeHeadersForSandbox(headers);
			expect(result).not.toHaveProperty("set-cookie");
			expect(result.accept).toBe("application/json");
		});

		it("strips authorization header", () => {
			const headers = new Headers({ authorization: "Bearer secret-token", host: "example.com" });
			const result = sanitizeHeadersForSandbox(headers);
			expect(result).not.toHaveProperty("authorization");
			expect(result.host).toBe("example.com");
		});

		it("strips proxy-authorization header", () => {
			const headers = new Headers({ "proxy-authorization": "Basic abc", host: "example.com" });
			const result = sanitizeHeadersForSandbox(headers);
			expect(result).not.toHaveProperty("proxy-authorization");
		});

		it("strips Cloudflare Access headers", () => {
			const headers = new Headers({
				"cf-access-jwt-assertion": "jwt-token",
				"cf-access-client-id": "client-id",
				"cf-access-client-secret": "client-secret",
				"cf-ray": "abc123",
			});
			const result = sanitizeHeadersForSandbox(headers);
			expect(result).not.toHaveProperty("cf-access-jwt-assertion");
			expect(result).not.toHaveProperty("cf-access-client-id");
			expect(result).not.toHaveProperty("cf-access-client-secret");
			expect(result["cf-ray"]).toBe("abc123");
		});

		it("strips x-emdash-request CSRF header", () => {
			const headers = new Headers({ "x-emdash-request": "1", "x-custom": "safe" });
			const result = sanitizeHeadersForSandbox(headers);
			expect(result).not.toHaveProperty("x-emdash-request");
			expect(result["x-custom"]).toBe("safe");
		});

		it("passes through safe headers unchanged", () => {
			const headers = new Headers({
				"content-type": "application/json",
				accept: "text/html",
				"user-agent": "TestBot/1.0",
				"x-forwarded-for": "1.2.3.4",
				"cf-connecting-ip": "5.6.7.8",
			});
			const result = sanitizeHeadersForSandbox(headers);
			expect(result["content-type"]).toBe("application/json");
			expect(result.accept).toBe("text/html");
			expect(result["user-agent"]).toBe("TestBot/1.0");
			expect(result["x-forwarded-for"]).toBe("1.2.3.4");
			expect(result["cf-connecting-ip"]).toBe("5.6.7.8");
		});

		it("returns empty object for headers that are all sensitive", () => {
			const headers = new Headers({
				cookie: "session=abc",
				authorization: "Bearer token",
			});
			const result = sanitizeHeadersForSandbox(headers);
			expect(Object.keys(result)).toHaveLength(0);
		});

		it("returns empty object for empty headers", () => {
			const headers = new Headers();
			const result = sanitizeHeadersForSandbox(headers);
			expect(Object.keys(result)).toHaveLength(0);
		});
	});

	describe("full extraction", () => {
		it("extracts all metadata from a fully-populated request", () => {
			const req = createRequest({
				headers: {
					"cf-connecting-ip": "203.0.113.50",
					"user-agent": "TestBot/1.0",
					referer: "https://example.com",
				},
				cf: { country: "DE", region: "BE", city: "Berlin" },
			});

			const meta = extractRequestMeta(req);
			expect(meta).toEqual({
				ip: "203.0.113.50",
				userAgent: "TestBot/1.0",
				referer: "https://example.com",
				geo: {
					country: "DE",
					region: "BE",
					city: "Berlin",
				},
			});
		});

		it("returns all nulls for a bare request", () => {
			const req = createRequest();

			const meta = extractRequestMeta(req);
			expect(meta).toEqual({
				ip: null,
				userAgent: null,
				referer: null,
				geo: null,
			});
		});
	});

	// --------------------------------------------------------------------
	// Trusted proxy headers — operator-declared headers for self-hosted
	// deployments behind a reverse proxy they control.
	// --------------------------------------------------------------------

	describe("trusted proxy headers", () => {
		it("reads the IP from a trusted header on a non-CF deployment", () => {
			const req = createRequest({
				headers: { "x-real-ip": "203.0.113.50" },
			});
			const meta = extractRequestMeta(req, { trustedProxyHeaders: ["x-real-ip"] });
			expect(meta.ip).toBe("203.0.113.50");
		});

		it("tries trusted headers in order", () => {
			const req = createRequest({
				headers: {
					"x-real-ip": "203.0.113.50",
					"fly-client-ip": "198.51.100.7",
				},
			});
			const meta = extractRequestMeta(req, {
				trustedProxyHeaders: ["fly-client-ip", "x-real-ip"],
			});
			expect(meta.ip).toBe("198.51.100.7");
		});

		it("falls through to the next trusted header when the first is missing", () => {
			const req = createRequest({
				headers: { "x-real-ip": "203.0.113.50" },
			});
			const meta = extractRequestMeta(req, {
				trustedProxyHeaders: ["fly-client-ip", "x-real-ip"],
			});
			expect(meta.ip).toBe("203.0.113.50");
		});

		it("treats trusted XFF-style headers as comma-separated and takes the first entry", () => {
			const req = createRequest({
				headers: {
					"x-forwarded-for": "203.0.113.50, 10.0.0.1, 10.0.0.2",
				},
			});
			const meta = extractRequestMeta(req, {
				trustedProxyHeaders: ["x-forwarded-for"],
			});
			expect(meta.ip).toBe("203.0.113.50");
		});

		it("rejects non-IP-shaped values in trusted headers", () => {
			const req = createRequest({
				headers: { "x-real-ip": "<script>alert(1)</script>" },
			});
			const meta = extractRequestMeta(req, { trustedProxyHeaders: ["x-real-ip"] });
			expect(meta.ip).toBeNull();
		});

		it("matches header names case-insensitively", () => {
			const req = createRequest({
				headers: { "X-Real-IP": "203.0.113.50" },
			});
			const meta = extractRequestMeta(req, { trustedProxyHeaders: ["x-real-ip"] });
			expect(meta.ip).toBe("203.0.113.50");
		});

		it("does not read from headers that are not on the trusted list", () => {
			// "x-client-ip" is not declared trusted — must not be used.
			const req = createRequest({
				headers: { "x-client-ip": "203.0.113.50" },
			});
			const meta = extractRequestMeta(req, { trustedProxyHeaders: ["x-real-ip"] });
			expect(meta.ip).toBeNull();
		});

		it("CF-Connecting-IP wins over trusted headers on Cloudflare", () => {
			// On CF, cf-connecting-ip is cryptographically trustworthy (CF edge
			// overwrites any client-supplied value). Operator-declared trusted
			// headers only apply as a fallback, not an override, so a wrong
			// entry in the config can't regress CF deployments.
			const req = createRequest({
				headers: {
					"cf-connecting-ip": "1.1.1.1",
					"x-real-ip": "203.0.113.50",
				},
				cf: {},
			});
			const meta = extractRequestMeta(req, { trustedProxyHeaders: ["x-real-ip"] });
			expect(meta.ip).toBe("1.1.1.1");
		});

		it("trusted headers are used as fallback when CF headers are absent", () => {
			const req = createRequest({
				headers: {
					"x-real-ip": "203.0.113.50",
				},
				cf: {},
			});
			const meta = extractRequestMeta(req, { trustedProxyHeaders: ["x-real-ip"] });
			expect(meta.ip).toBe("203.0.113.50");
		});

		it("falls back to the CF path when no trusted header matches", () => {
			const req = createRequest({
				headers: { "cf-connecting-ip": "1.1.1.1" },
				cf: {},
			});
			const meta = extractRequestMeta(req, { trustedProxyHeaders: ["x-real-ip"] });
			expect(meta.ip).toBe("1.1.1.1");
		});
	});
});
