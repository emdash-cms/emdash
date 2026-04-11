import { describe, expect, it } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { isTotpEnabled } from "../../../src/auth/totp-config.js";

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
