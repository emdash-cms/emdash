import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { isTotpAvailable, isTotpEnabled } from "../../../src/auth/totp-config.js";

describe("isTotpEnabled", () => {
	it("defaults to enabled when config is null", () => {
		expect(isTotpEnabled(null)).toBe(true);
	});

	it("defaults to enabled when config is undefined", () => {
		expect(isTotpEnabled(undefined)).toBe(true);
	});

	it("defaults to enabled when the totp block is missing", () => {
		expect(isTotpEnabled({} as EmDashConfig)).toBe(true);
	});

	it("defaults to enabled when totp.enabled is missing", () => {
		expect(isTotpEnabled({ totp: {} } as EmDashConfig)).toBe(true);
	});

	it("returns true when totp.enabled is explicitly true", () => {
		expect(isTotpEnabled({ totp: { enabled: true } } as EmDashConfig)).toBe(true);
	});

	it("returns false only when totp.enabled is explicitly false", () => {
		expect(isTotpEnabled({ totp: { enabled: false } } as EmDashConfig)).toBe(false);
	});
});

describe("isTotpAvailable", () => {
	beforeEach(() => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "");
		vi.stubEnv("AUTH_SECRET", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns false when config is disabled regardless of env", () => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "a".repeat(32));
		expect(isTotpAvailable({ totp: { enabled: false } } as EmDashConfig)).toBe(false);
	});

	it("returns false when enabled but EMDASH_AUTH_SECRET is missing", () => {
		expect(isTotpAvailable({} as EmDashConfig)).toBe(false);
	});

	it("returns false when enabled but the secret is too short", () => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "too-short");
		expect(isTotpAvailable({} as EmDashConfig)).toBe(false);
	});

	it("returns true when config allows AND a sufficient secret is set", () => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "a".repeat(32));
		expect(isTotpAvailable({} as EmDashConfig)).toBe(true);
	});

	it("returns true for an explicit enabled: true with a sufficient secret", () => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "a".repeat(32));
		expect(isTotpAvailable({ totp: { enabled: true } } as EmDashConfig)).toBe(true);
	});
});
