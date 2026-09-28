/**
 * Tests for SSRF protection in import/ssrf.ts
 *
 * Covers:
 * - IPv4-mapped IPv6 hex normalization (#58)
 * - Private IP detection across all forms
 * - validateExternalUrl blocking internal targets
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	cloudflareDohResolver,
	normalizeIPv6MappedToIPv4,
	resolveAndValidateExternalUrl,
	SsrfError,
	ssrfSafeFetch,
	validateExternalUrl,
} from "../../../src/import/ssrf.js";
import { resolveAndValidateExternalUrlTarget } from "../../../src/security/ssrf.js";

describe("ssrfSafeFetch HTTPS policy", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("rejects a redirect from HTTPS to HTTP when HTTPS is required", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { Location: "http://downloads.example.test/archive" },
			}),
		);
		vi.stubGlobal("fetch", fetch);

		await expect(
			ssrfSafeFetch("https://publisher.example.test/record", undefined, {
				httpsOnly: true,
				resolver: async () => ["93.184.216.34"],
			}),
		).rejects.toThrow("Only HTTPS URLs are allowed");
		expect(fetch).toHaveBeenCalledOnce();
	});
});

describe("validateExternalUrl", () => {
	// =========================================================================
	// Basic validation
	// =========================================================================

	it("accepts valid external URLs", () => {
		expect(validateExternalUrl("https://example.com")).toBeInstanceOf(URL);
		expect(validateExternalUrl("https://wordpress.org/feed")).toBeInstanceOf(URL);
		expect(validateExternalUrl("http://93.184.216.34/path")).toBeInstanceOf(URL);
	});

	it("rejects non-http schemes", () => {
		expect(() => validateExternalUrl("ftp://example.com")).toThrow(SsrfError);
		expect(() => validateExternalUrl("file:///etc/passwd")).toThrow(SsrfError);
		expect(() => validateExternalUrl("javascript:alert(1)")).toThrow(SsrfError);
	});

	it("rejects invalid URLs", () => {
		expect(() => validateExternalUrl("not a url")).toThrow(SsrfError);
		expect(() => validateExternalUrl("")).toThrow(SsrfError);
	});

	// =========================================================================
	// Blocked hostnames
	// =========================================================================

	it("blocks localhost", () => {
		expect(() => validateExternalUrl("http://localhost/path")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://localhost:8080")).toThrow(SsrfError);
	});

	it("blocks metadata endpoints", () => {
		expect(() => validateExternalUrl("http://metadata.google.internal/")).toThrow(SsrfError);
	});

	// =========================================================================
	// IPv4 private ranges
	// =========================================================================

	it("blocks loopback (127.0.0.0/8)", () => {
		expect(() => validateExternalUrl("http://127.0.0.1/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://127.255.255.255/")).toThrow(SsrfError);
	});

	it("blocks private 10.0.0.0/8", () => {
		expect(() => validateExternalUrl("http://10.0.0.1/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://10.255.255.255/")).toThrow(SsrfError);
	});

	it("blocks private 172.16.0.0/12", () => {
		expect(() => validateExternalUrl("http://172.16.0.1/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://172.31.255.255/")).toThrow(SsrfError);
	});

	it("blocks private 192.168.0.0/16", () => {
		expect(() => validateExternalUrl("http://192.168.0.1/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://192.168.255.255/")).toThrow(SsrfError);
	});

	it("blocks link-local (169.254.0.0/16) including cloud metadata", () => {
		expect(() => validateExternalUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
			SsrfError,
		);
		expect(() => validateExternalUrl("http://169.254.0.1/")).toThrow(SsrfError);
	});

	it("blocks shared address space (100.64.0.0/10)", () => {
		expect(() => validateExternalUrl("http://100.64.0.0/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://100.100.100.200/latest/meta-data/")).toThrow(
			SsrfError,
		);
		expect(() => validateExternalUrl("http://100.127.255.255/")).toThrow(SsrfError);
	});

	it("preserves public IPv4 literals adjacent to shared address space", () => {
		expect(validateExternalUrl("http://100.63.255.255/")).toBeInstanceOf(URL);
		expect(validateExternalUrl("http://100.128.0.0/")).toBeInstanceOf(URL);
	});

	it.each([
		"192.0.0.8",
		"192.0.2.1",
		"192.88.99.2",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"240.0.0.1",
	])("blocks non-public IPv4 special-purpose address %s", (address) => {
		expect(() => validateExternalUrl(`http://${address}/`)).toThrow(SsrfError);
	});

	it.each([
		"191.255.255.255",
		"192.0.1.0",
		"192.0.1.255",
		"192.0.3.0",
		"192.88.98.255",
		"192.88.100.0",
		"198.17.255.255",
		"198.20.0.0",
		"198.51.99.255",
		"198.51.101.0",
		"203.0.112.255",
		"203.0.114.0",
		"223.255.255.255",
	])("preserves IPv4 literal outside blocked range boundary %s", (address) => {
		expect(validateExternalUrl(`http://${address}/`)).toBeInstanceOf(URL);
	});

	it.each(["192.0.0.9", "192.0.0.10", "192.31.196.1", "192.52.193.1", "192.175.48.1"])(
		"preserves globally reachable IPv4 special-purpose address %s",
		(address) => {
			expect(validateExternalUrl(`http://${address}/`)).toBeInstanceOf(URL);
		},
	);

	// =========================================================================
	// IPv6 loopback
	// =========================================================================

	it("blocks IPv6 loopback [::1]", () => {
		expect(() => validateExternalUrl("http://[::1]/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://[::1]:8080/")).toThrow(SsrfError);
	});

	it("blocks the IPv6 unspecified address [::]", () => {
		expect(() => validateExternalUrl("http://[::]/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://[::]:8080/")).toThrow(SsrfError);
	});

	it.each([
		"400::1",
		"1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"64:ff9b:1::1",
		"100::1",
		"100:0:0:1::1",
		"2001:1::4",
		"2001:2::1",
		"2001:4:111::1",
		"2001:4:113::1",
		"2001:5::1",
		"2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
		"2001:40::1",
		"2001:db8::1",
		"2002::1",
		"3ffe::1",
		"3fff::1",
		"4000::1",
		"5f00::1",
		"5f01::1",
		"fe00::1",
		"fe90::1",
		"fec0::1",
		"ff02::1",
	])("blocks non-public IPv6 special-purpose address %s", (address) => {
		expect(() => validateExternalUrl(`http://[${address}]/`)).toThrow(SsrfError);
	});

	it.each([
		"2000::1",
		"2001:1::1",
		"2001:1::2",
		"2001:1::3",
		"2001:3::1",
		"2001:4:112::1",
		"2001:20::1",
		"2001:2f:ffff::1",
		"2001:30::1",
		"2001:3f:ffff::1",
		"2001:200::1",
		"2606:4700:4700::1111",
		"3ffd:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"3fff:1000::1",
	])("preserves globally reachable IPv6 address %s", (address) => {
		expect(validateExternalUrl(`http://[${address}]/`)).toBeInstanceOf(URL);
	});

	// =========================================================================
	// Issue #58: IPv4-mapped IPv6 in hex form
	//
	// The WHATWG URL parser normalizes [::ffff:127.0.0.1] to [::ffff:7f00:1].
	// Before the fix, the hex form bypassed isPrivateIp() because the regex
	// only matched dotted-decimal.
	// =========================================================================

	it("blocks IPv4-mapped IPv6 loopback in hex form [::ffff:7f00:1]", () => {
		// This is the normalized form of [::ffff:127.0.0.1]
		expect(() => validateExternalUrl("http://[::ffff:7f00:1]/evil")).toThrow(SsrfError);
	});

	it("blocks IPv4-mapped IPv6 cloud metadata [::ffff:a9fe:a9fe]", () => {
		// This is the normalized form of [::ffff:169.254.169.254]
		expect(() => validateExternalUrl("http://[::ffff:a9fe:a9fe]/latest/meta-data/")).toThrow(
			SsrfError,
		);
	});

	it("blocks IPv4-mapped IPv6 private 10.x [::ffff:a00:1]", () => {
		// This is the normalized form of [::ffff:10.0.0.1]
		expect(() => validateExternalUrl("http://[::ffff:a00:1]/")).toThrow(SsrfError);
	});

	it("blocks IPv4-mapped IPv6 private 192.168.x [::ffff:c0a8:1]", () => {
		// This is the normalized form of [::ffff:192.168.0.1]
		expect(() => validateExternalUrl("http://[::ffff:c0a8:1]/")).toThrow(SsrfError);
	});

	it("blocks IPv4-mapped IPv6 private 172.16.x [::ffff:ac10:1]", () => {
		// This is the normalized form of [::ffff:172.16.0.1]
		expect(() => validateExternalUrl("http://[::ffff:ac10:1]/")).toThrow(SsrfError);
	});

	it("blocks IPv4-mapped IPv6 in dotted-decimal form", () => {
		// The dotted-decimal form should also be blocked (it worked before too)
		// The URL parser normalizes this to hex, so this exercises the same path
		expect(() => validateExternalUrl("http://[::ffff:127.0.0.1]/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://[::ffff:169.254.169.254]/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://[::ffff:10.0.0.1]/")).toThrow(SsrfError);
	});

	it("allows IPv4-mapped IPv6 for public IPs", () => {
		// [::ffff:93.184.216.34] -> hex form after URL parsing
		// 93 = 0x5d, 184 = 0xb8 -> 0x5db8
		// 216 = 0xd8, 34 = 0x22 -> 0xd822
		// So [::ffff:5db8:d822] should be allowed
		expect(validateExternalUrl("http://[::ffff:5db8:d822]/")).toBeInstanceOf(URL);
	});

	// =========================================================================
	// IPv4-compatible (deprecated) addresses: ::XXXX:XXXX (no ffff prefix)
	//
	// [::127.0.0.1] normalizes to [::7f00:1] which has no ffff prefix.
	// Without the fix, these bypass all ffff-based checks.
	// =========================================================================

	it("blocks IPv4-compatible loopback [::7f00:1]", () => {
		// Normalized form of [::127.0.0.1]
		expect(() => validateExternalUrl("http://[::7f00:1]/evil")).toThrow(SsrfError);
	});

	it("blocks IPv4-compatible cloud metadata [::a9fe:a9fe]", () => {
		// Normalized form of [::169.254.169.254]
		expect(() => validateExternalUrl("http://[::a9fe:a9fe]/latest/meta-data/")).toThrow(SsrfError);
	});

	it("blocks IPv4-compatible private 10.x [::a00:1]", () => {
		// Normalized form of [::10.0.0.1]
		expect(() => validateExternalUrl("http://[::a00:1]/")).toThrow(SsrfError);
	});

	it("blocks IPv4-compatible private 192.168.x [::c0a8:1]", () => {
		// Normalized form of [::192.168.0.1]
		expect(() => validateExternalUrl("http://[::c0a8:1]/")).toThrow(SsrfError);
	});

	it("allows IPv4-compatible public IPs [::5db8:d822]", () => {
		// 93.184.216.34 in hex
		expect(validateExternalUrl("http://[::5db8:d822]/")).toBeInstanceOf(URL);
	});

	// =========================================================================
	// NAT64 prefix: 64:ff9b::XXXX:XXXX
	//
	// [64:ff9b::127.0.0.1] normalizes to [64:ff9b::7f00:1].
	// NAT64 gateways embed IPv4 in IPv6 using this well-known prefix.
	// =========================================================================

	it("blocks NAT64 loopback [64:ff9b::7f00:1]", () => {
		expect(() => validateExternalUrl("http://[64:ff9b::7f00:1]/evil")).toThrow(SsrfError);
	});

	it("blocks NAT64 cloud metadata [64:ff9b::a9fe:a9fe]", () => {
		expect(() => validateExternalUrl("http://[64:ff9b::a9fe:a9fe]/latest/meta-data/")).toThrow(
			SsrfError,
		);
	});

	it("blocks NAT64 private 10.x [64:ff9b::a00:1]", () => {
		expect(() => validateExternalUrl("http://[64:ff9b::a00:1]/")).toThrow(SsrfError);
	});

	it("blocks NAT64 private 192.168.x [64:ff9b::c0a8:1]", () => {
		expect(() => validateExternalUrl("http://[64:ff9b::c0a8:1]/")).toThrow(SsrfError);
	});

	it("allows NAT64 public IPs [64:ff9b::5db8:d822]", () => {
		expect(validateExternalUrl("http://[64:ff9b::5db8:d822]/")).toBeInstanceOf(URL);
	});

	// =========================================================================
	// IPv6 link-local and ULA
	// =========================================================================

	it("blocks IPv6 link-local (fe80::)", () => {
		expect(() => validateExternalUrl("http://[fe80::1]/")).toThrow(SsrfError);
	});

	it("blocks IPv6 unique local (fc00::/fd00::)", () => {
		expect(() => validateExternalUrl("http://[fc00::1]/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://[fd00::1]/")).toThrow(SsrfError);
	});

	it("blocks 0.0.0.0/8 range", () => {
		expect(() => validateExternalUrl("http://0.0.0.0/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://0.0.0.1/")).toThrow(SsrfError);
	});

	// IPv4 literals with trailing dots. A single trailing dot is stripped by
	// the WHATWG URL parser, but multiple trailing dots are preserved on
	// .hostname. parseIpv4 rejects anything with a dot count != 4, so
	// "127.0.0.1.." falls through to isPrivateIp's IPv6 fallback and
	// returns false, bypassing the private-IP check. We must strip trailing
	// dots before the private-IP check.
	it("blocks IPv4 literals with trailing dots", () => {
		expect(() => validateExternalUrl("http://127.0.0.1./")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://127.0.0.1../")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://169.254.169.254../")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://10.0.0.1../")).toThrow(SsrfError);
	});
});

// =============================================================================
// normalizeIPv6MappedToIPv4 — direct unit tests (#58)
//
// This function converts IPv4-mapped/translated IPv6 hex addresses back to
// dotted-decimal IPv4 so they can be checked against private ranges. Without
// it, the WHATWG URL parser's hex normalization bypasses SSRF protection.
// =============================================================================

describe("normalizeIPv6MappedToIPv4", () => {
	// =========================================================================
	// Standard hex-form: ::ffff:XXXX:XXXX
	// =========================================================================

	it("converts loopback ::ffff:7f00:1 -> 127.0.0.1", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:7f00:1")).toBe("127.0.0.1");
	});

	it("converts cloud metadata ::ffff:a9fe:a9fe -> 169.254.169.254", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:a9fe:a9fe")).toBe("169.254.169.254");
	});

	it("converts private 10.x ::ffff:a00:1 -> 10.0.0.1", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:a00:1")).toBe("10.0.0.1");
	});

	it("converts private 192.168.x ::ffff:c0a8:1 -> 192.168.0.1", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:c0a8:1")).toBe("192.168.0.1");
	});

	it("converts private 172.16.x ::ffff:ac10:1 -> 172.16.0.1", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:ac10:1")).toBe("172.16.0.1");
	});

	it("converts public IP ::ffff:5db8:d822 -> 93.184.216.34", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:5db8:d822")).toBe("93.184.216.34");
	});

	// =========================================================================
	// Edge values
	// =========================================================================

	it("converts ::ffff:0:0 -> 0.0.0.0", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:0:0")).toBe("0.0.0.0");
	});

	it("converts ::ffff:ffff:ffff -> 255.255.255.255", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:ffff:ffff")).toBe("255.255.255.255");
	});

	it("converts 4-digit hex groups correctly ::ffff:c612:e3a -> 198.18.14.58", () => {
		// 0xc612 = 198*256 + 18 = 50706
		// 0x0e3a = 14*256 + 58 = 3642
		expect(normalizeIPv6MappedToIPv4("::ffff:c612:e3a")).toBe("198.18.14.58");
	});

	// =========================================================================
	// Case insensitivity
	// =========================================================================

	it("handles uppercase hex digits", () => {
		expect(normalizeIPv6MappedToIPv4("::FFFF:7F00:1")).toBe("127.0.0.1");
	});

	it("handles mixed case hex digits", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:A9FE:a9fe")).toBe("169.254.169.254");
	});

	// =========================================================================
	// Bracket-wrapped form returns null (brackets stripped by caller)
	// validateExternalUrl strips brackets before calling isPrivateIp,
	// so normalizeIPv6MappedToIPv4 never receives bracketed input.
	// =========================================================================

	it("returns null for bracketed input (brackets stripped by caller)", () => {
		expect(normalizeIPv6MappedToIPv4("[::ffff:7f00:1]")).toBeNull();
		expect(normalizeIPv6MappedToIPv4("[::ffff:a9fe:a9fe]")).toBeNull();
	});

	// =========================================================================
	// IPv4-translated (RFC 6052): ::ffff:0:XXXX:XXXX
	// =========================================================================

	it("converts translated form ::ffff:0:7f00:1 -> 127.0.0.1", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:0:7f00:1")).toBe("127.0.0.1");
	});

	it("converts translated form ::ffff:0:a9fe:a9fe -> 169.254.169.254", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:0:a9fe:a9fe")).toBe("169.254.169.254");
	});

	// =========================================================================
	// Fully expanded form: 0000:0000:0000:0000:0000:ffff:XXXX:XXXX
	// =========================================================================

	it("converts expanded form 0:0:0:0:0:ffff:7f00:1 -> 127.0.0.1", () => {
		expect(normalizeIPv6MappedToIPv4("0:0:0:0:0:ffff:7f00:1")).toBe("127.0.0.1");
	});

	it("converts expanded form 0000:0000:0000:0000:0000:ffff:a9fe:a9fe -> 169.254.169.254", () => {
		expect(normalizeIPv6MappedToIPv4("0000:0000:0000:0000:0000:ffff:a9fe:a9fe")).toBe(
			"169.254.169.254",
		);
	});

	it("converts expanded form with mixed zero lengths", () => {
		expect(normalizeIPv6MappedToIPv4("0:00:000:0000:0:ffff:a00:1")).toBe("10.0.0.1");
	});

	// =========================================================================
	// IPv4-compatible (deprecated) form: ::XXXX:XXXX (no ffff prefix)
	// =========================================================================

	it("converts IPv4-compatible loopback ::7f00:1 -> 127.0.0.1", () => {
		expect(normalizeIPv6MappedToIPv4("::7f00:1")).toBe("127.0.0.1");
	});

	it("converts IPv4-compatible metadata ::a9fe:a9fe -> 169.254.169.254", () => {
		expect(normalizeIPv6MappedToIPv4("::a9fe:a9fe")).toBe("169.254.169.254");
	});

	it("converts IPv4-compatible private ::a00:1 -> 10.0.0.1", () => {
		expect(normalizeIPv6MappedToIPv4("::a00:1")).toBe("10.0.0.1");
	});

	it("converts IPv4-compatible public ::5db8:d822 -> 93.184.216.34", () => {
		expect(normalizeIPv6MappedToIPv4("::5db8:d822")).toBe("93.184.216.34");
	});

	// =========================================================================
	// NAT64 prefix (RFC 6052): 64:ff9b::XXXX:XXXX
	// =========================================================================

	it("converts NAT64 loopback 64:ff9b::7f00:1 -> 127.0.0.1", () => {
		expect(normalizeIPv6MappedToIPv4("64:ff9b::7f00:1")).toBe("127.0.0.1");
	});

	it("converts NAT64 metadata 64:ff9b::a9fe:a9fe -> 169.254.169.254", () => {
		expect(normalizeIPv6MappedToIPv4("64:ff9b::a9fe:a9fe")).toBe("169.254.169.254");
	});

	it("converts NAT64 private 64:ff9b::a00:1 -> 10.0.0.1", () => {
		expect(normalizeIPv6MappedToIPv4("64:ff9b::a00:1")).toBe("10.0.0.1");
	});

	it("converts NAT64 public 64:ff9b::5db8:d822 -> 93.184.216.34", () => {
		expect(normalizeIPv6MappedToIPv4("64:ff9b::5db8:d822")).toBe("93.184.216.34");
	});

	// =========================================================================
	// Non-matching inputs -> null
	// =========================================================================

	it("returns null for plain IPv4", () => {
		expect(normalizeIPv6MappedToIPv4("127.0.0.1")).toBeNull();
	});

	it("returns null for IPv6 loopback ::1", () => {
		expect(normalizeIPv6MappedToIPv4("::1")).toBeNull();
	});

	it("returns null for regular IPv6 address", () => {
		expect(normalizeIPv6MappedToIPv4("2001:db8::1")).toBeNull();
	});

	it("returns null for link-local IPv6", () => {
		expect(normalizeIPv6MappedToIPv4("fe80::1")).toBeNull();
	});

	it("returns null for hostnames", () => {
		expect(normalizeIPv6MappedToIPv4("example.com")).toBeNull();
		expect(normalizeIPv6MappedToIPv4("localhost")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(normalizeIPv6MappedToIPv4("")).toBeNull();
	});

	it("only normalizes hex addresses", () => {
		expect(normalizeIPv6MappedToIPv4("::ffff:127.0.0.1")).toBeNull();
	});
});

// =============================================================================
// Wildcard DNS services — hostname blocklist
//
// Services like nip.io map "127.0.0.1.nip.io" to 127.0.0.1. Without DNS
// resolution they pass validateExternalUrl since the hostname is neither an
// IP literal nor on the small internal-names list. Adding the apex domains
// to BLOCKED_HOSTNAMES catches the most widely-used rebinding tools without
// requiring a network round-trip.
// =============================================================================

describe("validateExternalUrl — wildcard DNS rebinding services", () => {
	it("blocks nip.io and its subdomains", () => {
		expect(() => validateExternalUrl("http://nip.io/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://127.0.0.1.nip.io/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://169.254.169.254.nip.io/latest/")).toThrow(SsrfError);
	});

	it("blocks sslip.io and its subdomains", () => {
		expect(() => validateExternalUrl("http://sslip.io/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://127.0.0.1.sslip.io/")).toThrow(SsrfError);
	});

	it("blocks xip.io and its subdomains", () => {
		expect(() => validateExternalUrl("http://xip.io/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://10.0.0.1.xip.io/")).toThrow(SsrfError);
	});

	it("blocks traefik.me and its subdomains", () => {
		expect(() => validateExternalUrl("http://traefik.me/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://127.0.0.1.traefik.me/")).toThrow(SsrfError);
	});

	it("is case-insensitive for blocklisted hostnames", () => {
		expect(() => validateExternalUrl("http://NIP.IO/")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://127.0.0.1.Nip.Io/")).toThrow(SsrfError);
	});

	// Trailing-dot FQDN form. The WHATWG URL parser preserves the dot on
	// `.hostname`, so a naive exact-match or `.endsWith(suffix)` check misses
	// these. Without explicit normalization, attackers can bypass both
	// BLOCKED_HOSTNAMES and the suffix list by appending a single dot.
	it("blocks trailing-dot FQDNs on the hostname blocklist", () => {
		expect(() => validateExternalUrl("http://localhost./")).toThrow(SsrfError);
	});

	it("blocks trailing-dot FQDNs on the wildcard suffix list", () => {
		expect(() => validateExternalUrl("http://nip.io./")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://127.0.0.1.nip.io./")).toThrow(SsrfError);
		expect(() => validateExternalUrl("http://sslip.io./")).toThrow(SsrfError);
	});

	it("allows look-alike domains that are not on the blocklist", () => {
		// Defensive: we should only block specific known services, not any
		// domain that happens to contain "nip" or similar.
		expect(validateExternalUrl("http://nippon.example.com/")).toBeInstanceOf(URL);
	});
});

// =============================================================================
// resolveAndValidateExternalUrl — async DNS-aware validation
//
// Runs validateExternalUrl first (cheap pre-flight), then resolves the
// hostname via an injectable resolver and checks each returned IP against
// the private-range blocklist. Catches DNS rebinding attacks using domains
// the attacker controls (not just known public rebinding services).
// =============================================================================

describe("resolveAndValidateExternalUrl", () => {
	// Helper: build a stubbed resolver that returns a fixed list of IPs.
	function resolver(ips: string[]): (host: string) => Promise<string[]> {
		return async () => ips;
	}

	// Helper: a resolver that fails. Used to assert fail-closed behaviour.
	function failingResolver(error = new Error("DNS failure")) {
		return async () => {
			throw error;
		};
	}

	it("accepts public IPs", async () => {
		const url = await resolveAndValidateExternalUrl("https://example.com/", {
			resolver: resolver(["93.184.216.34"]),
		});
		expect(url).toBeInstanceOf(URL);
		expect(url.hostname).toBe("example.com");
	});

	it.each([
		"1.1.1.1",
		"12.0.0.1",
		"::ffff:1.1.1.1",
		"::ffff:0:1.1.1.1",
		"::1.1.1.1",
		"64:ff9b::1.1.1.1",
		"2001:4860:4860::8888",
		"2001:4860:4860:0:0:0:0:8888",
		"::ffff:808:808",
		"0:0:0:0:0:ffff:808:808",
		"0:0:0:0:0:ffff:8.8.8.8",
		"0:0::ffff:8.8.8.8",
		"::ffff:0:808:808",
		"0:0:0:0:ffff:0:808:808",
		"0:0:0:0:ffff:0:8.8.8.8",
		"::808:808",
		"0:0:0:0:0:0:808:808",
		"0:0:0:0:0:0:8.8.8.8",
		"64:ff9b::808:808",
		"64:ff9b:0:0:0:0:808:808",
		"64:ff9b:0:0:0:0:8.8.8.8",
		"2001:4860:4860::8.8.8.8",
		"2001:4860:4860:0:0:0:8.8.8.8",
		"2001:4860:4860::127.0.0.1",
	])("accepts strict public resolver address %s", async (address) => {
		const target = await resolveAndValidateExternalUrlTarget("https://example.com/", {
			resolver: resolver([address]),
		});
		expect(target.url).toBeInstanceOf(URL);
		expect(target.addresses).toEqual([address]);
	});

	it.each([
		"localhost",
		"not-an-ip",
		"1.1.1.",
		"012.0.0.1",
		"2001:4860:4860:0:0:0:0:8888::",
		"2001:4860:4860::8.8.8.256",
		"::ffff:008.8.8.8",
		"2001:4860:4860:0:0:0:0:8.8.8.8",
		"2001:4860:4860:0:0:8.8.8.8",
		"2001:4860::8.8.8.8:1",
		"2001:::4860:8888",
		"2001::4860::8888",
		"2001:4860:4860::8888%eth0",
	])("rejects invalid resolver result %s", async (address) => {
		await expect(
			resolveAndValidateExternalUrl("https://attacker.example/", {
				resolver: resolver([address]),
			}),
		).rejects.toThrow(SsrfError);
	});

	it.each([
		"::ffff:7f00:1",
		"0:0:0:0:0:ffff:7f00:1",
		"0:0:0:0:0:ffff:127.0.0.1",
		"0:0::ffff:127.0.0.1",
		"::ffff:0:a9fe:a9fe",
		"0:0:0:0:ffff:0:a9fe:a9fe",
		"0:0:0:0:ffff:0:169.254.169.254",
		"::a00:1",
		"0:0:0:0:0:0:a00:1",
		"0:0:0:0:0:0:10.0.0.1",
		"64:ff9b::a00:1",
		"64:ff9b:0:0:0:0:a00:1",
		"64:ff9b:0:0:0:0:10.0.0.1",
		"0:0:0:0:0:0:0:0",
		"0:0:0:0:0:0:0:1",
	])("rejects non-public resolver address %s alongside a public address", async (address) => {
		await expect(
			resolveAndValidateExternalUrl("https://attacker.example/", {
				resolver: resolver(["8.8.8.8", address]),
			}),
		).rejects.toThrow(SsrfError);
	});

	it("rejects hostnames that resolve to loopback", async () => {
		await expect(
			resolveAndValidateExternalUrl("https://attacker.example/", {
				resolver: resolver(["127.0.0.1"]),
			}),
		).rejects.toThrow(SsrfError);
	});

	it("rejects hostnames that resolve to cloud metadata IP", async () => {
		await expect(
			resolveAndValidateExternalUrl("https://attacker.example/", {
				resolver: resolver(["169.254.169.254"]),
			}),
		).rejects.toThrow(SsrfError);
	});

	it("rejects hostnames that resolve to any RFC1918 address", async () => {
		for (const ip of ["10.0.0.1", "172.16.0.1", "192.168.1.1"]) {
			await expect(
				resolveAndValidateExternalUrl("https://attacker.example/", {
					resolver: resolver([ip]),
				}),
			).rejects.toThrow(SsrfError);
		}
	});

	it("rejects if ANY resolved IP is private (multi-record DNS rebinding)", async () => {
		// Attacker serves two A records; we must reject if either is private,
		// not just the first one.
		await expect(
			resolveAndValidateExternalUrl("https://attacker.example/", {
				resolver: resolver(["93.184.216.34", "127.0.0.1"]),
			}),
		).rejects.toThrow(SsrfError);
	});

	it("rejects IPv6 loopback in resolved records", async () => {
		await expect(
			resolveAndValidateExternalUrl("https://attacker.example/", {
				resolver: resolver(["::1"]),
			}),
		).rejects.toThrow(SsrfError);
	});

	it("rejects IPv6 link-local in resolved records (any case)", async () => {
		for (const ip of ["fe80::1", "FE80::1", "Fe80::abcd"]) {
			await expect(
				resolveAndValidateExternalUrl("https://attacker.example/", {
					resolver: resolver([ip]),
				}),
			).rejects.toThrow(SsrfError);
		}
	});

	it("rejects IPv6 unique-local in resolved records (any case)", async () => {
		for (const ip of ["fc00::1", "FC00::1", "fd12:3456::1", "FD00::BEEF"]) {
			await expect(
				resolveAndValidateExternalUrl("https://attacker.example/", {
					resolver: resolver([ip]),
				}),
			).rejects.toThrow(SsrfError);
		}
	});

	it("rejects IPv4-mapped IPv6 loopback in resolved records", async () => {
		await expect(
			resolveAndValidateExternalUrl("https://attacker.example/", {
				resolver: resolver(["::ffff:127.0.0.1"]),
			}),
		).rejects.toThrow(SsrfError);
	});

	it("accepts public IPv6 addresses", async () => {
		const url = await resolveAndValidateExternalUrl("https://example.com/", {
			resolver: resolver(["2606:4700:4700::1111"]),
		});
		expect(url).toBeInstanceOf(URL);
	});

	it("runs synchronous validateExternalUrl first (short-circuits on literal IP)", async () => {
		// 127.0.0.1 as a literal hostname is caught by validateExternalUrl
		// before any DNS lookup. Pass a resolver that would throw to prove it
		// isn't called.
		const r = failingResolver(new Error("should not be called"));
		await expect(
			resolveAndValidateExternalUrl("http://127.0.0.1/", { resolver: r }),
		).rejects.toThrow(SsrfError);
	});

	it("fails closed when the resolver throws", async () => {
		await expect(
			resolveAndValidateExternalUrl("https://example.com/", {
				resolver: failingResolver(),
			}),
		).rejects.toThrow(SsrfError);
	});

	it("rejects empty resolver result (hostname resolves to nothing)", async () => {
		await expect(
			resolveAndValidateExternalUrl("https://example.com/", {
				resolver: resolver([]),
			}),
		).rejects.toThrow(SsrfError);
	});

	it("returns the parsed URL on success", async () => {
		const url = await resolveAndValidateExternalUrl("https://example.com/path?q=1", {
			resolver: resolver(["93.184.216.34"]),
		});
		expect(url.pathname).toBe("/path");
		expect(url.searchParams.get("q")).toBe("1");
	});
});

// =============================================================================
// cloudflareDohResolver — unit tests for the DoH parser
//
// Stubs globalThis.fetch to simulate various DoH responses. The resolver
// must:
//   - return IPs from valid A and AAAA responses
//   - treat NXDOMAIN (Status=3) as an empty result (legitimately non-existent)
//   - fail closed on SERVFAIL (Status=2), REFUSED (Status=5), and other
//     non-zero statuses, so that split-view DNS can't smuggle a private IP
//     past the check by SERVFAIL'ing one record type
//   - fail on HTTP errors
//   - fail on malformed JSON or responses with missing fields
// =============================================================================

describe("cloudflareDohResolver", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function stubFetch(
		responses: Record<"A" | "AAAA", { body?: unknown; status?: number; throws?: Error }>,
	): void {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const type: "A" | "AAAA" = url.includes("type=AAAA") ? "AAAA" : "A";
			const res = responses[type];
			if (res.throws) throw res.throws;
			return new Response(JSON.stringify(res.body ?? {}), { status: res.status ?? 200 });
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub
		}) as unknown as typeof globalThis.fetch;
	}

	it("returns A and AAAA records from a valid Status=0 response", async () => {
		stubFetch({
			A: { body: { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] } },
			AAAA: { body: { Status: 0, Answer: [{ type: 28, data: "2606:4700::1" }] } },
		});

		const ips = await cloudflareDohResolver("example.com");
		expect(ips).toContain("93.184.216.34");
		expect(ips).toContain("2606:4700::1");
	});

	it("treats NXDOMAIN (Status=3) as empty (legitimately no records)", async () => {
		stubFetch({
			A: { body: { Status: 3 } },
			AAAA: { body: { Status: 3 } },
		});
		const ips = await cloudflareDohResolver("does-not-exist.example");
		expect(ips).toEqual([]);
	});

	it("fails closed on SERVFAIL (Status=2)", async () => {
		// Split-view attack: attacker authoritative NS returns SERVFAIL to
		// Cloudflare's resolver but real records to the victim's resolver.
		// If we silently treated SERVFAIL as empty, we'd combine whatever
		// the other record type returned and call it "public" — bypassing
		// the check.
		stubFetch({
			A: { body: { Status: 2 } },
			AAAA: { body: { Status: 0, Answer: [{ type: 28, data: "2606:4700::1" }] } },
		});
		await expect(cloudflareDohResolver("attacker.example")).rejects.toThrow();
	});

	it("fails closed on REFUSED (Status=5)", async () => {
		stubFetch({
			A: { body: { Status: 5 } },
			AAAA: { body: { Status: 0, Answer: [{ type: 28, data: "2606:4700::1" }] } },
		});
		await expect(cloudflareDohResolver("attacker.example")).rejects.toThrow();
	});

	it("fails closed on HTTP errors from the DoH endpoint", async () => {
		stubFetch({
			A: { status: 500 },
			AAAA: { body: { Status: 0, Answer: [] } },
		});
		await expect(cloudflareDohResolver("example.com")).rejects.toThrow();
	});

	it("fails closed on malformed response bodies missing Status", async () => {
		stubFetch({
			A: { body: {} },
			AAAA: { body: { Status: 0, Answer: [] } },
		});
		await expect(cloudflareDohResolver("example.com")).rejects.toThrow();
	});

	it("fails closed on network errors", async () => {
		stubFetch({
			A: { throws: new Error("network down") },
			AAAA: { body: { Status: 0, Answer: [] } },
		});
		await expect(cloudflareDohResolver("example.com")).rejects.toThrow();
	});

	it("returns empty array when both A and AAAA return no records but Status=0", async () => {
		stubFetch({
			A: { body: { Status: 0, Answer: [] } },
			AAAA: { body: { Status: 0, Answer: [] } },
		});
		const ips = await cloudflareDohResolver("example.com");
		expect(ips).toEqual([]);
	});

	it("skips Answer entries without string data", async () => {
		stubFetch({
			A: {
				body: {
					Status: 0,
					Answer: [
						{ type: 1, data: "93.184.216.34" },
						{ type: 1, data: 12345 },
						{},
						{ type: 1, notData: "foo" },
					],
				},
			},
			AAAA: { body: { Status: 0, Answer: [] } },
		});
		const ips = await cloudflareDohResolver("example.com");
		expect(ips).toEqual(["93.184.216.34"]);
	});

	// DoH responses often include CNAME records in the Answer chain alongside
	// (or instead of) A/AAAA records. Their `data` field is a hostname, not
	// an IP. If we return them, the validator's isPrivateIp check silently
	// accepts them (parseIpv4 returns null → "not private" → pass).
	it("filters CNAME-style hostname answers, keeping only IP literals", async () => {
		stubFetch({
			A: {
				body: {
					Status: 0,
					Answer: [
						{ type: 5, data: "cdn.example.com." }, // CNAME target, not an IP
						{ type: 1, data: "93.184.216.34" }, // real A record
					],
				},
			},
			AAAA: {
				body: {
					Status: 0,
					Answer: [
						{ type: 5, data: "other.example.com." },
						{ type: 28, data: "2606:4700::1" },
					],
				},
			},
		});
		const ips = await cloudflareDohResolver("example.com");
		expect(ips).toEqual(["93.184.216.34", "2606:4700::1"]);
	});

	it("rejects a response that contains only CNAME strings", async () => {
		stubFetch({
			A: {
				body: {
					Status: 0,
					Answer: [{ type: 5, data: "target.example.com." }],
				},
			},
			AAAA: { body: { Status: 0, Answer: [] } },
		});
		const ips = await cloudflareDohResolver("cname-only.example");
		// No IPs at all — the caller should treat this as "could not resolve"
		// and fail closed, not pretend the CNAME target is an address.
		expect(ips).toEqual([]);
	});

	it("filters IP-shaped answers whose DNS type does not match the query", async () => {
		stubFetch({
			A: {
				body: {
					Status: 0,
					Answer: [
						{ type: 5, data: "192.0.2.1" },
						{ type: 28, data: "2606:4700::1" },
						{ type: 1, data: "93.184.216.34" },
					],
				},
			},
			AAAA: {
				body: {
					Status: 0,
					Answer: [
						{ type: 5, data: "2606:4700::2" },
						{ type: 1, data: "93.184.216.35" },
						{ type: 28, data: "2606:4700::1" },
					],
				},
			},
		});

		await expect(cloudflareDohResolver("example.com")).resolves.toEqual([
			"93.184.216.34",
			"2606:4700::1",
		]);
	});
});
