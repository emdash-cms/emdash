/**
 * Tests for getTrustedProxyHeaders — resolves the list of trusted client-IP
 * headers from config, falling back to the EMDASH_TRUSTED_PROXY_HEADERS env
 * var, then to an empty array.
 *
 * The helper lets operators declare which headers they trust when running
 * behind a reverse proxy. On Cloudflare the `cf` object is used instead and
 * this list is usually empty.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	_resetTrustedProxyHeadersCache,
	getTrustedProxyHeaders,
} from "../../../src/auth/trusted-proxy.js";

describe("getTrustedProxyHeaders", () => {
	const ORIGINAL_ENV = process.env.EMDASH_TRUSTED_PROXY_HEADERS;

	beforeEach(() => {
		_resetTrustedProxyHeadersCache();
	});

	afterEach(() => {
		if (ORIGINAL_ENV === undefined) {
			delete process.env.EMDASH_TRUSTED_PROXY_HEADERS;
		} else {
			process.env.EMDASH_TRUSTED_PROXY_HEADERS = ORIGINAL_ENV;
		}
		_resetTrustedProxyHeadersCache();
	});

	it("returns config value when set", () => {
		expect(getTrustedProxyHeaders({ trustedProxyHeaders: ["x-real-ip"] })).toEqual(["x-real-ip"]);
	});

	it("prefers config over env", () => {
		process.env.EMDASH_TRUSTED_PROXY_HEADERS = "fly-client-ip";
		expect(getTrustedProxyHeaders({ trustedProxyHeaders: ["x-real-ip"] })).toEqual(["x-real-ip"]);
	});

	it("falls back to env when config is absent", () => {
		process.env.EMDASH_TRUSTED_PROXY_HEADERS = "x-real-ip,fly-client-ip";
		expect(getTrustedProxyHeaders(undefined)).toEqual(["x-real-ip", "fly-client-ip"]);
	});

	it("trims whitespace and drops empty entries from env", () => {
		process.env.EMDASH_TRUSTED_PROXY_HEADERS = " x-real-ip , , fly-client-ip ";
		expect(getTrustedProxyHeaders(undefined)).toEqual(["x-real-ip", "fly-client-ip"]);
	});

	it("lowercases header names for consistent matching", () => {
		// Header lookups go through Headers.get() which is case-insensitive,
		// so we normalise the list here to avoid double-normalising elsewhere.
		expect(getTrustedProxyHeaders({ trustedProxyHeaders: ["X-Real-IP", "Fly-Client-IP"] })).toEqual(
			["x-real-ip", "fly-client-ip"],
		);
	});

	it("returns empty array when neither config nor env is set", () => {
		delete process.env.EMDASH_TRUSTED_PROXY_HEADERS;
		expect(getTrustedProxyHeaders(undefined)).toEqual([]);
	});

	it("returns empty array when config has empty list", () => {
		process.env.EMDASH_TRUSTED_PROXY_HEADERS = "x-real-ip";
		// An explicit empty array means "trust nothing" — do not fall through
		// to the env. Operators use this to override an inherited env value.
		expect(getTrustedProxyHeaders({ trustedProxyHeaders: [] })).toEqual([]);
	});

	// Header names must be valid RFC 7230 tokens; passing anything else into
	// `Headers.get()` throws. Drop invalid entries silently rather than
	// taking down every rate-limited endpoint with a 500.
	it("drops invalid header names from config", () => {
		expect(
			getTrustedProxyHeaders({
				trustedProxyHeaders: ["x-real-ip", "", "invalid name", "bad:colon", "ok-name"],
			}),
		).toEqual(["x-real-ip", "ok-name"]);
	});

	it("drops invalid header names from env", () => {
		process.env.EMDASH_TRUSTED_PROXY_HEADERS = "x-real-ip, x y z , bad:one, ok-name";
		expect(getTrustedProxyHeaders(undefined)).toEqual(["x-real-ip", "ok-name"]);
	});

	it("trims whitespace from config entries before matching", () => {
		// Common typo: `"x-real-ip "` (trailing space). Previously the raw
		// value was lowercased but not trimmed, so validation silently
		// dropped it and per-IP bucketing was disabled.
		expect(
			getTrustedProxyHeaders({ trustedProxyHeaders: [" x-real-ip ", "fly-client-ip"] }),
		).toEqual(["x-real-ip", "fly-client-ip"]);
	});
});
