import { describe, expect, it } from "vitest";

import { CAPABILITY_RENAMES, describeCapability } from "../src/index.js";

describe("describeCapability", () => {
	it("describes a deprecated capability name as its replacement", () => {
		for (const [legacy, current] of Object.entries(CAPABILITY_RENAMES)) {
			expect(describeCapability(legacy)).toEqual(describeCapability(current));
			expect(describeCapability(legacy)).toBeDefined();
		}
	});

	it("returns undefined for a capability outside the vocabulary", () => {
		expect(describeCapability("custom:something")).toBeUndefined();
		expect(describeCapability("toString")).toBeUndefined();
	});
});
