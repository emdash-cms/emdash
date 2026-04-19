import { describe, expect, it, vi } from "vitest";

// Default stub: no host-provided waitUntil. Mirrors what Node (and
// any adapter that doesn't implement the virtual) sees at runtime.
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

// The waitUntil-handoff path is exercised end-to-end by the cron
// integration in emdash-runtime.ts; testing it here would require
// swapping out a module that's already bound at load time, which
// fights vitest's module cache. These unit tests cover the three
// behaviors that don't need a real waitUntil: the callback fires,
// errors don't escape, and the caller doesn't block.
import { after } from "../../src/after.js";

describe("after()", () => {
	it("runs the callback", async () => {
		const fn = vi.fn();
		after(fn);
		await new Promise((r) => setTimeout(r, 0));
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("swallows errors and logs them with the emdash prefix", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const boom = new Error("boom");

		try {
			expect(() =>
				after(async () => {
					throw boom;
				}),
			).not.toThrow();

			await new Promise((r) => setTimeout(r, 0));

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[emdash] deferred task failed"),
				boom,
			);
		} finally {
			// Restore unconditionally so a failed assertion above doesn't leak
			// the spy into later tests.
			errorSpy.mockRestore();
		}
	});

	it("returns synchronously without waiting for the callback", async () => {
		let ran = false;
		after(async () => {
			await new Promise((r) => setTimeout(r, 10));
			ran = true;
		});
		// after() returned already — the callback hasn't completed.
		expect(ran).toBe(false);
	});
});
