import { describe, it, expect } from "vitest";

import { getPasskeyConfig } from "../../../src/auth/passkey-config.js";

/** URL shape from `new URL(request.url)` after trusted proxy + Astro `security.allowedDomains`. */
function urlAfterTrustedProxy(path: string, host: string, proto: "http" | "https"): URL {
	return new URL(path, `${proto}://${host}`);
}

describe("passkey-config", () => {
	describe("getPasskeyConfig() via emulated reverse proxy URL", () => {
		const internalDevUrl = "http://127.0.0.1:4321/_emdash/api/auth/passkey/register/options";

		it("loopback URL alone matches Node before rewrite — rpId is not the public host", () => {
			const url = new URL(internalDevUrl);
			expect(getPasskeyConfig(url).rpId).toBe("127.0.0.1");
		});

		it("forwarded Host/Proto yield the URL handlers see; rp matches HTTP reverse-proxy edge", () => {
			const url = urlAfterTrustedProxy(
				"/_emdash/api/auth/passkey/register/options",
				"emdash.local:8080",
				"http",
			);
			const config = getPasskeyConfig(url, "My Site");
			expect(config.rpId).toBe("emdash.local");
			expect(config.rpName).toBe("My Site");
			expect(config.origin).toBe("http://emdash.local:8080");
		});

		it("HTTPS listener on proxy with HTTP upstream: siteUrl aligns origin with browser", () => {
			const urlAstroSeesFromForwardedHttp = urlAfterTrustedProxy(
				"/_emdash/api/setup/admin",
				"emdash.local:8080",
				"http",
			);
			const browserOrigin = "https://emdash.local:8443";
			const config = getPasskeyConfig(urlAstroSeesFromForwardedHttp, "My Site", browserOrigin);
			expect(config.rpId).toBe("emdash.local");
			expect(config.rpName).toBe("My Site");
			expect(config.origin).toBe(browserOrigin);
		});
	});

	describe("getPasskeyConfig()", () => {
		it("throws when siteUrl is not a valid URL", () => {
			const url = new URL("http://localhost:4321/admin");
			expect(() => getPasskeyConfig(url, "Site", "::not-a-url")).toThrow("Invalid siteUrl");
		});

		it("extracts rpId from localhost URL", () => {
			const url = new URL("http://localhost:4321/admin");
			const config = getPasskeyConfig(url);

			expect(config.rpId).toBe("localhost");
		});

		it("extracts rpId from production URL", () => {
			const url = new URL("https://example.com/admin");
			const config = getPasskeyConfig(url);

			expect(config.rpId).toBe("example.com");
		});

		it("extracts rpId from subdomain URL", () => {
			const url = new URL("https://admin.example.com/dashboard");
			const config = getPasskeyConfig(url);

			expect(config.rpId).toBe("admin.example.com");
		});

		it("returns correct origin for http", () => {
			const url = new URL("http://localhost:4321/admin");
			const config = getPasskeyConfig(url);

			expect(config.origin).toBe("http://localhost:4321");
		});

		it("returns correct origin for https", () => {
			const url = new URL("https://example.com/admin");
			const config = getPasskeyConfig(url);

			expect(config.origin).toBe("https://example.com");
		});

		it("handles port numbers correctly", () => {
			const url = new URL("http://localhost:3000/setup");
			const config = getPasskeyConfig(url);

			expect(config.rpId).toBe("localhost");
			expect(config.origin).toBe("http://localhost:3000");
		});

		it("handles https with non-standard port", () => {
			const url = new URL("https://staging.example.com:8443/admin");
			const config = getPasskeyConfig(url);

			expect(config.rpId).toBe("staging.example.com");
			expect(config.origin).toBe("https://staging.example.com:8443");
		});

		it("uses hostname as rpName by default", () => {
			const url = new URL("https://example.com/admin");
			const config = getPasskeyConfig(url);

			expect(config.rpName).toBe("example.com");
		});

		it("uses provided siteName for rpName", () => {
			const url = new URL("https://example.com/admin");
			const config = getPasskeyConfig(url, "My Cool Site");

			expect(config.rpName).toBe("My Cool Site");
			expect(config.rpId).toBe("example.com");
		});

		it("ignores path and query params for origin", () => {
			const url = new URL("https://example.com:443/admin/setup?foo=bar#section");
			const config = getPasskeyConfig(url);

			// Standard https port 443 is omitted from origin
			expect(config.origin).toBe("https://example.com");
			expect(config.rpId).toBe("example.com");
		});

		it("documents HTTPS reverse-proxy dev pitfall: server URL scheme must match the browser", () => {
			const serverDevUrl = new URL("http://emdash.local:8443/_emdash/api/setup/admin");
			const browserPageOrigin = new URL("https://emdash.local:8443/_emdash/admin/setup");

			const fromServer = getPasskeyConfig(serverDevUrl);
			const fromBrowser = getPasskeyConfig(browserPageOrigin);

			expect(fromServer.rpId).toBe(fromBrowser.rpId);
			expect(fromServer.origin).toBe("http://emdash.local:8443");
			expect(fromBrowser.origin).toBe("https://emdash.local:8443");
			// verifyRegistrationResponse requires clientData.origin === config.origin (see @emdash-cms/auth/passkey)
			expect(fromServer.origin).not.toBe(fromBrowser.origin);
		});

		it("siteUrl overrides origin and rpId (TLS termination and loopback request URL)", () => {
			const fromForwardedHttp = getPasskeyConfig(
				new URL("http://emdash.local:8443/_emdash/api/setup/admin"),
				"My Site",
				"https://emdash.local:8443",
			);
			expect(fromForwardedHttp.rpName).toBe("My Site");
			expect(fromForwardedHttp.rpId).toBe("emdash.local");
			expect(fromForwardedHttp.origin).toBe("https://emdash.local:8443");

			const fromLoopback = getPasskeyConfig(
				new URL("http://127.0.0.1:4321/_emdash/api/setup/admin"),
				"My CMS",
				"https://public.example:8443",
			);
			expect(fromLoopback.rpId).toBe("public.example");
			expect(fromLoopback.rpName).toBe("My CMS");
			expect(fromLoopback.origin).toBe("https://public.example:8443");

			const hostnameOnly = getPasskeyConfig(
				new URL("http://127.0.0.1:4321/x"),
				undefined,
				"https://public.example:8443",
			);
			expect(hostnameOnly.rpName).toBe("public.example");
			expect(hostnameOnly.rpId).toBe("public.example");
		});
	});
});
