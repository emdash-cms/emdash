import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
	getPublicOrigin,
	getPublicUrl,
	getEnvAllowedOrigins,
	_resetEnvCache,
} from "../../../src/api/public-url.js";
import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";

// Snapshot env vars we'll mutate, and restore after every test.
const origEmdashSiteUrl = process.env.EMDASH_SITE_URL;
const origSiteUrl = process.env.SITE_URL;
const origAllowedOrigins = process.env.EMDASH_ALLOWED_ORIGINS;

afterEach(() => {
	_resetEnvCache();
	// Restore original env state (delete if originally absent)
	if (origEmdashSiteUrl === undefined) delete process.env.EMDASH_SITE_URL;
	else process.env.EMDASH_SITE_URL = origEmdashSiteUrl;
	if (origSiteUrl === undefined) delete process.env.SITE_URL;
	else process.env.SITE_URL = origSiteUrl;
	if (origAllowedOrigins === undefined) delete process.env.EMDASH_ALLOWED_ORIGINS;
	else process.env.EMDASH_ALLOWED_ORIGINS = origAllowedOrigins;
});

// Ensure clean state before every test (no cache, no test env vars).
beforeEach(() => {
	_resetEnvCache();
	delete process.env.EMDASH_SITE_URL;
	delete process.env.SITE_URL;
	delete process.env.EMDASH_ALLOWED_ORIGINS;
});

describe("getPublicOrigin()", () => {
	it("returns config.siteUrl when set", () => {
		const url = new URL("http://localhost:4321/admin");
		const config: EmDashConfig = { siteUrl: "https://mysite.example.com" };
		expect(getPublicOrigin(url, config)).toBe("https://mysite.example.com");
	});

	it("returns url.origin when config has no siteUrl", () => {
		const url = new URL("http://localhost:4321/admin");
		const config: EmDashConfig = {};
		expect(getPublicOrigin(url, config)).toBe("http://localhost:4321");
	});

	it("returns url.origin when config is undefined", () => {
		const url = new URL("https://example.com:8443/setup");
		expect(getPublicOrigin(url)).toBe("https://example.com:8443");
	});

	it("returns url.origin when config.siteUrl is undefined", () => {
		const url = new URL("http://127.0.0.1:4321/api");
		expect(getPublicOrigin(url, { siteUrl: undefined })).toBe("http://127.0.0.1:4321");
	});

	it("does not return empty string siteUrl (falsy)", () => {
		const url = new URL("http://localhost:4321/x");
		// Empty string should fall through to url.origin
		expect(getPublicOrigin(url, { siteUrl: "" })).toBe("http://localhost:4321");
	});
});

describe("getPublicOrigin() env var fallback", () => {
	it("falls back to EMDASH_SITE_URL when config has no siteUrl", () => {
		process.env.EMDASH_SITE_URL = "https://env.example.com";
		const url = new URL("http://localhost:4321/x");
		expect(getPublicOrigin(url, {})).toBe("https://env.example.com");
	});

	it("falls back to SITE_URL when EMDASH_SITE_URL is absent", () => {
		process.env.SITE_URL = "https://site-url.example.com";
		const url = new URL("http://localhost:4321/x");
		expect(getPublicOrigin(url, {})).toBe("https://site-url.example.com");
	});

	it("prefers EMDASH_SITE_URL over SITE_URL", () => {
		process.env.EMDASH_SITE_URL = "https://emdash.example.com";
		process.env.SITE_URL = "https://site.example.com";
		const url = new URL("http://localhost:4321/x");
		expect(getPublicOrigin(url, {})).toBe("https://emdash.example.com");
	});

	it("normalizes env var to origin (strips path)", () => {
		process.env.EMDASH_SITE_URL = "https://env.example.com/some/path";
		const url = new URL("http://localhost:4321/x");
		expect(getPublicOrigin(url, {})).toBe("https://env.example.com");
	});

	it("falls through to url.origin when env var is invalid URL", () => {
		process.env.EMDASH_SITE_URL = "not-a-url";
		const url = new URL("http://localhost:4321/x");
		expect(getPublicOrigin(url, {})).toBe("http://localhost:4321");
	});

	it("config.siteUrl takes precedence over env var", () => {
		process.env.EMDASH_SITE_URL = "https://env.example.com";
		const url = new URL("http://localhost:4321/x");
		const config: EmDashConfig = { siteUrl: "https://config.example.com" };
		expect(getPublicOrigin(url, config)).toBe("https://config.example.com");
	});

	it("cache is invalidated by _resetEnvCache()", () => {
		process.env.EMDASH_SITE_URL = "https://first.example.com";
		const url = new URL("http://localhost:4321/x");
		expect(getPublicOrigin(url, {})).toBe("https://first.example.com");

		_resetEnvCache();
		process.env.EMDASH_SITE_URL = "https://second.example.com";
		expect(getPublicOrigin(url, {})).toBe("https://second.example.com");
	});
});

describe("getEnvAllowedOrigins()", () => {
	it("returns [] when EMDASH_ALLOWED_ORIGINS is unset", () => {
		expect(getEnvAllowedOrigins()).toEqual([]);
	});

	it("parses a comma-separated list into origins", () => {
		process.env.EMDASH_ALLOWED_ORIGINS = "https://example.com,https://preview.example.com";
		expect(getEnvAllowedOrigins()).toEqual(["https://example.com", "https://preview.example.com"]);
	});

	it("trims whitespace around each entry", () => {
		process.env.EMDASH_ALLOWED_ORIGINS = "  https://example.com ,   https://preview.example.com  ";
		expect(getEnvAllowedOrigins()).toEqual(["https://example.com", "https://preview.example.com"]);
	});

	it("normalizes each entry to its origin (strips path/query)", () => {
		process.env.EMDASH_ALLOWED_ORIGINS = "https://example.com/x?y=1";
		expect(getEnvAllowedOrigins()).toEqual(["https://example.com"]);
	});

	it("throws on entries with non-http(s) protocols", () => {
		process.env.EMDASH_ALLOWED_ORIGINS = "file:///etc/passwd,https://example.com";
		expect(() => getEnvAllowedOrigins()).toThrow(/EMDASH_ALLOWED_ORIGINS.*must be http or https/);
	});

	it("throws on unparseable entries", () => {
		process.env.EMDASH_ALLOWED_ORIGINS = "not-a-url,https://example.com";
		expect(() => getEnvAllowedOrigins()).toThrow(/EMDASH_ALLOWED_ORIGINS.*invalid URL/);
	});

	it("cache is invalidated by _resetEnvCache()", () => {
		process.env.EMDASH_ALLOWED_ORIGINS = "https://first.example.com";
		expect(getEnvAllowedOrigins()).toEqual(["https://first.example.com"]);

		_resetEnvCache();
		process.env.EMDASH_ALLOWED_ORIGINS = "https://second.example.com";
		expect(getEnvAllowedOrigins()).toEqual(["https://second.example.com"]);
	});
});

describe("getPublicUrl()", () => {
	it("builds full URL from siteUrl + path", () => {
		const url = new URL("http://localhost:4321/x");
		const config: EmDashConfig = { siteUrl: "https://mysite.example.com" };
		expect(getPublicUrl(url, config, "/_emdash/admin/login")).toBe(
			"https://mysite.example.com/_emdash/admin/login",
		);
	});

	it("builds full URL from request origin when no siteUrl", () => {
		const url = new URL("http://localhost:4321/x");
		expect(getPublicUrl(url, undefined, "/_emdash/admin/login")).toBe(
			"http://localhost:4321/_emdash/admin/login",
		);
	});
});
