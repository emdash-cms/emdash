import { describe, expect, it } from "vitest";

import { getLifecycleCanaryPhase } from "../../evals/canary/lifecycle-canary.js";

describe("lifecycle canary", () => {
	it("returns phase-one", () => {
		expect(getLifecycleCanaryPhase()).toBe("phase-one");
	});
});
