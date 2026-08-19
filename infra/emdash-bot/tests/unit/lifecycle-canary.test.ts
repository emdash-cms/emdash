import { describe, expect, test } from "vitest";

import { getLifecycleCanaryPhase } from "../../evals/canary/lifecycle-canary.js";

describe("lifecycle canary", () => {
	test("returns the phase-one canary phase", () => {
		expect(getLifecycleCanaryPhase()).toBe("phase-one");
	});
});
