/**
 * Coverage for `validatePublishUrl`. The function is the syntactic SSRF
 * guard in publish: the FIRST line of defence before the redirect-loop
 * DNS check. Bugs here have historically produced silent SSRF (see
 * round-3 -> round-4 review notes), so the test net is dense around
 * IPv6-literal, IPv4-mapped, and bracketed-host edge cases.
 */
import { describe, expect, it } from "vitest";

import { validatePublishUrlForTest as validate } from "../src/commands/publish.js";

describe("validatePublishUrl", () => {
	describe("rejects non-public IPv4 literals", () => {
		it.each([
			"https://127.0.0.1/x",
			"https://10.0.0.1/x",
			"https://192.168.1.1/x",
			"https://172.16.0.1/x",
			"https://172.31.255.255/x",
			"https://169.254.169.254/x", // AWS metadata
			"https://0.0.0.0/x",
			"https://100.64.0.1/x", // CGNAT
		])("blocks %s", (url) => {
			expect(validate(url)).not.toBeNull();
		});

		it.each(["https://172.15.0.1/x", "https://172.32.0.1/x"])(
			"allows %s (just outside private range)",
			(url) => {
				expect(validate(url)).toBeNull();
			},
		);
	});

	describe("rejects non-public IPv6 literals", () => {
		// These are the cases the round-3 fix claimed to handle but which
		// silently passed because Node's URL parser keeps the brackets and
		// normalises any embedded IPv4 to two hex groups.
		it.each([
			"https://[::1]/x", // loopback
			"https://[fc00::1]/x", // ULA
			"https://[fd00::1]/x", // ULA
			"https://[fe80::1]/x", // link-local
			"https://[::ffff:169.254.169.254]/x", // IPv4-mapped to AWS metadata
			"https://[::ffff:127.0.0.1]/x", // IPv4-mapped loopback
			"https://[::ffff:10.0.0.1]/x", // IPv4-mapped RFC1918
			"https://[::169.254.169.254]/x", // IPv4-compatible (deprecated)
			"https://[64:ff9b::169.254.169.254]/x", // NAT64 well-known prefix
		])("blocks %s", (url) => {
			expect(validate(url)).not.toBeNull();
		});

		it.each([
			"https://[2001:db8::1]/x", // documentation prefix; not on the deny list
			"https://[2606:4700::1]/x", // public Cloudflare
		])("allows %s", (url) => {
			expect(validate(url)).toBeNull();
		});
	});

	it("rejects localhost / .local hostnames", () => {
		expect(validate("https://localhost/x")).not.toBeNull();
		expect(validate("https://my-machine.local/x")).not.toBeNull();
	});

	it("rejects FQDN trailing-dot variants of denied hostnames", () => {
		// Round-5 finding M-1: mDNS resolvers respond to both `foo.local`
		// and `foo.local.`; the syntactic guard has to canonicalise.
		expect(validate("https://localhost./x")).not.toBeNull();
		expect(validate("https://my-machine.local./x")).not.toBeNull();
	});

	it("does not over-block public IPv6 with private-looking suffix", () => {
		// Round-5 finding M-2: a generic "decode last two hex groups as v4"
		// fallback would false-positive on `2001:db8::a00:1` (last 32 bits
		// decode to 10.0.0.1). The fix restricts the embedded-v4 check to
		// known v4-carrying prefixes (NAT64, 6to4).
		expect(validate("https://[2001:db8::a00:1]/x")).toBeNull();
	});

	it("rejects 6to4 with embedded private v4", () => {
		// 6to4 prefix 2002:: encodes the v4 in groups 2-3 (not the suffix).
		// `2002:0a00:0001::1` -> v4 10.0.0.1 -> private.
		expect(validate("https://[2002:a00:1::1]/x")).not.toBeNull();
	});

	it("rejects RFC 8215 local-use NAT64 prefix with embedded private v4", () => {
		// `64:ff9b:1::/48` is the local-use NAT64 prefix; embedded v4 is in
		// the last 32 bits. `64:ff9b:1:0:0:0:a9fe:a9fe` -> 169.254.169.254.
		expect(validate("https://[64:ff9b:1:0:0:0:a9fe:a9fe]/x")).not.toBeNull();
	});

	it("rejects http://", () => {
		expect(validate("http://example.com/x")).not.toBeNull();
	});

	it("rejects file://, ftp://", () => {
		expect(validate("file:///etc/passwd")).not.toBeNull();
		expect(validate("ftp://example.com/x")).not.toBeNull();
	});

	it("rejects malformed URLs", () => {
		expect(validate("not a url")).not.toBeNull();
		expect(validate("")).not.toBeNull();
	});

	it("allows ordinary public https URLs", () => {
		expect(validate("https://example.com/file.tar.gz")).toBeNull();
		expect(validate("https://github.com/owner/repo/releases/download/v1/x.tar.gz")).toBeNull();
		expect(validate("https://cdn.example.com:8443/path?query=1#frag")).toBeNull();
	});
});
