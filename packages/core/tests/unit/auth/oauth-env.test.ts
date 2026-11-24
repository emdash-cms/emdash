import { describe, expect, it } from "vitest";

import { resolveOAuthEnv } from "../../../src/auth/oauth-env.js";

const runtime = { EMDASH_OAUTH_GOOGLE_CLIENT_ID: "runtime-id" };
const build = {
	EMDASH_OAUTH_GOOGLE_CLIENT_ID: "build-id",
	EMDASH_OAUTH_GOOGLE_CLIENT_SECRET: "build-secret",
};

describe("resolveOAuthEnv", () => {
	it("returns the Cloudflare env unchanged", () => {
		const platform = { EMDASH_OAUTH_GOOGLE_CLIENT_ID: "cf-id" };
		expect(resolveOAuthEnv(platform, runtime, build, false)).toBe(platform);
	});

	it("ignores build-time values in production", () => {
		expect(resolveOAuthEnv(undefined, runtime, build, false)).toEqual(runtime);
	});

	it("falls back to build-time values in dev, with runtime winning", () => {
		expect(resolveOAuthEnv(undefined, runtime, build, true)).toEqual({
			EMDASH_OAUTH_GOOGLE_CLIENT_ID: "runtime-id",
			EMDASH_OAUTH_GOOGLE_CLIENT_SECRET: "build-secret",
		});
	});
});
