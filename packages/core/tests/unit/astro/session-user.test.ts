import { describe, expect, it, vi } from "vitest";

// `after()` lazily imports this virtual module (provided by the Astro
// integration at build time, absent in unit tests). Stub it so the lazy
// import resolves cleanly to a no-op lifetime extender.
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }));

import { resolveSessionUser } from "../../../src/astro/session-user.js";

describe("resolveSessionUser", () => {
	it("returns the session user when the read resolves", async () => {
		const session = { get: vi.fn(async () => ({ id: "user_1" })) };
		await expect(resolveSessionUser(session)).resolves.toEqual({ id: "user_1" });
		expect(session.get).toHaveBeenCalledWith("user");
	});

	it("returns undefined when there is no session", async () => {
		await expect(resolveSessionUser(undefined)).resolves.toBeUndefined();
	});

	// The core #1274 guarantee: a read that never settles (a workerd context
	// cancelled mid-read) must not hang — the timeout backstop resolves it.
	it("falls back to undefined instead of hanging when the read never settles", async () => {
		const session = { get: () => new Promise<{ id: string }>(() => {}) };
		await expect(resolveSessionUser(session, 20)).resolves.toBeUndefined();
	});

	// Fail-closed: a rejecting read resolves to undefined (caller treats the
	// request as unauthenticated) rather than throwing.
	it("fails closed to undefined when the read rejects", async () => {
		const session = { get: () => Promise.reject(new Error("boom")) };
		await expect(resolveSessionUser(session, 20)).resolves.toBeUndefined();
	});
});
