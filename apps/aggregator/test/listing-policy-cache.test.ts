import { describe, expect, it, vi } from "vitest";

describe("listing policy cache", () => {
	it("shares cached policy work across duplicate module instances", async () => {
		const runtimeEnv = {
			LISTING_POLICY_MODE: "projection",
			LISTING_ALLOWLIST: "[]",
			LISTING_MODERATION_POLICY: "{}",
		} as unknown as Env;

		vi.resetModules();
		const firstModule = await import("../src/listing-policy.js");
		const first = firstModule.getListingPolicy(runtimeEnv);

		vi.resetModules();
		const secondModule = await import("../src/listing-policy.js");
		const second = secondModule.getListingPolicy(runtimeEnv);

		expect(second).toBe(first);
		await expect(first).resolves.toMatchObject({ moderationPolicy: null });
	});
});
