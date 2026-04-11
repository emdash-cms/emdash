import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authSecretFailureMessage, resolveAuthSecret } from "../../../src/auth/auth-secret.js";

// import.meta.env is a Vite construct that vitest patches per-test via
// vi.stubEnv. The stubs don't leak across tests as long as we unstub in
// afterEach.
describe("resolveAuthSecret", () => {
	beforeEach(() => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "");
		vi.stubEnv("AUTH_SECRET", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns ok when EMDASH_AUTH_SECRET is set and long enough", () => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "a".repeat(32));
		const result = resolveAuthSecret();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.secret).toBe("a".repeat(32));
		}
	});

	it("falls back to AUTH_SECRET when EMDASH_AUTH_SECRET is unset", () => {
		vi.stubEnv("AUTH_SECRET", "b".repeat(32));
		const result = resolveAuthSecret();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.secret).toBe("b".repeat(32));
		}
	});

	it("prefers EMDASH_AUTH_SECRET over AUTH_SECRET when both are set", () => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "a".repeat(32));
		vi.stubEnv("AUTH_SECRET", "b".repeat(32));
		const result = resolveAuthSecret();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.secret).toBe("a".repeat(32));
		}
	});

	it("returns missing when neither env var is set", () => {
		const result = resolveAuthSecret();
		expect(result).toEqual({ ok: false, reason: "missing" });
	});

	it("returns too_short when the secret is shorter than 32 characters", () => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "short");
		const result = resolveAuthSecret();
		expect(result).toEqual({ ok: false, reason: "too_short" });
	});

	it("returns too_short at the exact boundary minus one", () => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "a".repeat(31));
		const result = resolveAuthSecret();
		expect(result).toEqual({ ok: false, reason: "too_short" });
	});

	it("accepts exactly 32 characters (inclusive boundary)", () => {
		vi.stubEnv("EMDASH_AUTH_SECRET", "a".repeat(32));
		const result = resolveAuthSecret();
		expect(result.ok).toBe(true);
	});
});

describe("authSecretFailureMessage", () => {
	it("tells the deployer how to generate a new secret when missing", () => {
		const msg = authSecretFailureMessage("missing");
		expect(msg).toContain("EMDASH_AUTH_SECRET");
		expect(msg).toContain("emdash auth secret");
		expect(msg).toContain("restart");
	});

	it("tells the deployer to regenerate when too short", () => {
		const msg = authSecretFailureMessage("too_short");
		expect(msg).toContain("EMDASH_AUTH_SECRET");
		expect(msg).toContain("32 characters");
		expect(msg).toContain("emdash auth secret");
	});
});
