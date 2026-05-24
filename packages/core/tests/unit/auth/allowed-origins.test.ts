import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetEnvCache } from "../../../src/api/public-url.js";
import {
	getConfiguredAllowedOrigins,
	validateAllowedOrigins,
	validateOriginShape,
	type TaggedOrigin,
} from "../../../src/auth/allowed-origins.js";

const origEnvAllowed = process.env.EMDASH_ALLOWED_ORIGINS;

beforeEach(() => {
	_resetEnvCache();
	delete process.env.EMDASH_ALLOWED_ORIGINS;
});

afterEach(() => {
	_resetEnvCache();
	if (origEnvAllowed === undefined) delete process.env.EMDASH_ALLOWED_ORIGINS;
	else process.env.EMDASH_ALLOWED_ORIGINS = origEnvAllowed;
});

function tag(
	origin: string,
	source: TaggedOrigin["source"] = "config.allowedOrigins",
): TaggedOrigin {
	return { origin, source };
}

describe("getConfiguredAllowedOrigins()", () => {
	it("returns [] when neither config nor env supplies origins", () => {
		expect(getConfiguredAllowedOrigins(undefined)).toEqual([]);
		expect(getConfiguredAllowedOrigins({})).toEqual([]);
	});

	it("tags config entries as config.allowedOrigins", () => {
		const tagged = getConfiguredAllowedOrigins({
			allowedOrigins: ["https://preview.example.com"],
		});
		expect(tagged).toEqual([
			{ origin: "https://preview.example.com", source: "config.allowedOrigins" },
		]);
	});

	it("tags env entries as EMDASH_ALLOWED_ORIGINS", () => {
		process.env.EMDASH_ALLOWED_ORIGINS = "https://preview.example.com";
		const tagged = getConfiguredAllowedOrigins({});
		expect(tagged).toEqual([
			{ origin: "https://preview.example.com", source: "EMDASH_ALLOWED_ORIGINS" },
		]);
	});

	it("merges config first, then env (config wins on dedupe by tag-of-first-occurrence)", () => {
		process.env.EMDASH_ALLOWED_ORIGINS = "https://staging.example.com";
		const tagged = getConfiguredAllowedOrigins({
			allowedOrigins: ["https://preview.example.com"],
		});
		expect(tagged).toEqual([
			{ origin: "https://preview.example.com", source: "config.allowedOrigins" },
			{ origin: "https://staging.example.com", source: "EMDASH_ALLOWED_ORIGINS" },
		]);
	});

	it("filters falsy config entries", () => {
		const tagged = getConfiguredAllowedOrigins({
			allowedOrigins: ["", "https://preview.example.com"],
		});
		expect(tagged).toEqual([
			{ origin: "https://preview.example.com", source: "config.allowedOrigins" },
		]);
	});
});

describe("validateOriginShape()", () => {
	it("returns [] for empty input", () => {
		expect(validateOriginShape([])).toEqual([]);
	});

	it("normalizes to URL.origin form (path/query stripped)", () => {
		expect(validateOriginShape([tag("https://example.com/admin?x=1")])).toEqual([
			"https://example.com",
		]);
	});

	it("dedupes duplicate origins", () => {
		expect(validateOriginShape([tag("https://example.com"), tag("https://example.com/x")])).toEqual(
			["https://example.com"],
		);
	});

	it("rejects unparseable URLs with source attribution", () => {
		expect(() => validateOriginShape([tag("not-a-url")])).toThrow(
			/EmDash config error in config\.allowedOrigins:.*invalid URL/,
		);
	});

	it("rejects non-http(s) protocols", () => {
		expect(() => validateOriginShape([tag("ftp://example.com", "EMDASH_ALLOWED_ORIGINS")])).toThrow(
			/EmDash config error in EMDASH_ALLOWED_ORIGINS:.*must be http or https.*ftp:/,
		);
	});

	it("rejects hostnames with trailing dots", () => {
		expect(() => validateOriginShape([tag("https://example.com.")])).toThrow(/trailing dot/);
	});

	it("rejects hostnames with empty labels", () => {
		// "foo..example.com" parses with hostname "foo..example.com"
		expect(() => validateOriginShape([tag("https://foo..example.com")])).toThrow(/empty labels/);
	});
});

describe("validateAllowedOrigins() — Rule A and Rule B", () => {
	it("returns [] when input is empty (no Rule A check fires)", () => {
		expect(validateAllowedOrigins(undefined, [])).toEqual([]);
		expect(validateAllowedOrigins("https://example.com", [])).toEqual([]);
	});

	it("throws Rule A when origins are non-empty but siteUrl is missing", () => {
		expect(() => validateAllowedOrigins(undefined, [tag("https://preview.example.com")])).toThrow(
			/allowedOrigins is set.*but siteUrl is not/,
		);
	});

	it("accepts an exact-hostname-match entry (apex listed alongside apex siteUrl)", () => {
		expect(validateAllowedOrigins("https://example.com", [tag("https://example.com")])).toEqual([
			"https://example.com",
		]);
	});

	it("accepts a true subdomain", () => {
		expect(
			validateAllowedOrigins("https://example.com", [tag("https://preview.example.com")]),
		).toEqual(["https://preview.example.com"]);
	});

	it("rejects a sibling/unrelated domain", () => {
		expect(() =>
			validateAllowedOrigins("https://example.com", [tag("https://other-site.com")]),
		).toThrow(/not a subdomain of siteUrl/);
	});

	it("rejects a suffix-attacker (example.com.evil.com)", () => {
		expect(() =>
			validateAllowedOrigins("https://example.com", [tag("https://example.com.evil.com")]),
		).toThrow(/not a subdomain of siteUrl/);
	});

	it("rejects a prefix-attacker (fakeexample.com)", () => {
		expect(() =>
			validateAllowedOrigins("https://example.com", [tag("https://fakeexample.com")]),
		).toThrow(/not a subdomain of siteUrl/);
	});

	it("rejects apex when siteHost is itself a subdomain", () => {
		// rpId would be app.example.com — the browser refuses apex assertions for it
		expect(() =>
			validateAllowedOrigins("https://app.example.com", [tag("https://example.com")]),
		).toThrow(/not a subdomain of siteUrl/);
	});

	it("rejects siteUrl with a trailing-dot hostname when allowedOrigins is non-empty", () => {
		expect(() =>
			validateAllowedOrigins("https://example.com.", [tag("https://preview.example.com")]),
		).toThrow(/trailing-dot hostname.*Remove the trailing dot/);
	});

	it("rejects IP-literal siteUrl (IPv4) when allowedOrigins is non-empty", () => {
		// IP-literal check fires before Rule B in the validator, so the entry shape
		// itself doesn't need to relate to the IP — any parseable origin triggers it.
		expect(() =>
			validateAllowedOrigins("http://127.0.0.1:4321", [tag("https://preview.example.com")]),
		).toThrow(/IP-literal hostname/);
	});

	it("rejects IP-literal siteUrl (IPv6) when allowedOrigins is non-empty", () => {
		expect(() =>
			validateAllowedOrigins("http://[::1]:4321", [tag("http://x.example.com")]),
		).toThrow(/IP-literal hostname/);
	});

	it("allows IP-literal siteUrl when allowedOrigins is empty (single-origin dev)", () => {
		expect(validateAllowedOrigins("http://127.0.0.1:4321", [])).toEqual([]);
	});

	it("accepts mixed config + env tagged origins", () => {
		const result = validateAllowedOrigins("https://example.com", [
			tag("https://preview.example.com", "config.allowedOrigins"),
			tag("https://staging.example.com", "EMDASH_ALLOWED_ORIGINS"),
		]);
		expect(result).toEqual(["https://preview.example.com", "https://staging.example.com"]);
	});

	it("attributes Rule B errors to the source of the offending entry", () => {
		expect(() =>
			validateAllowedOrigins("https://example.com", [
				tag("https://preview.example.com", "config.allowedOrigins"),
				tag("https://other-site.com", "EMDASH_ALLOWED_ORIGINS"),
			]),
		).toThrow(/EmDash config error in EMDASH_ALLOWED_ORIGINS.*not a subdomain/);
	});

	it("dedupes when config and env list the same origin", () => {
		const result = validateAllowedOrigins("https://example.com", [
			tag("https://preview.example.com", "config.allowedOrigins"),
			tag("https://preview.example.com", "EMDASH_ALLOWED_ORIGINS"),
		]);
		expect(result).toEqual(["https://preview.example.com"]);
	});
});
