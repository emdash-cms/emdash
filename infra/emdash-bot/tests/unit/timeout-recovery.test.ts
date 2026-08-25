import { describe, expect, test } from "vitest";

import {
	buildTimeoutSummaryPrompt,
	isTimeoutSummaryDelivery,
	resumeStateForMode,
} from "../../.flue/lib/timeout-recovery.js";

describe("timeout recovery", () => {
	test("recognizes only the summary-only delivery", () => {
		expect(
			isTimeoutSummaryDelivery({
				kind: "signal",
				type: "investigation.timeout-summary",
				body: "Summarize the stopped run.",
			}),
		).toBe(true);
		expect(
			isTimeoutSummaryDelivery({
				kind: "signal",
				type: "investigation.resume",
				body: "Continue the stopped run.",
			}),
		).toBe(false);
	});

	test("summary prompt asks for existing verification evidence without offering more work", () => {
		const prompt = buildTimeoutSummaryPrompt({
			mode: "implement",
			lastFailure: { stage: "verification", message: "test failed with exit 1" },
		});

		expect(prompt).toContain("No tools are available");
		expect(prompt).toContain("verification that passed or failed");
		expect(prompt).toContain("test failed with exit 1");
	});

	test("resume returns to the state owned by the saved run mode", () => {
		expect(resumeStateForMode("diagnose")).toBe("investigating");
		expect(resumeStateForMode("repro")).toBe("working");
		expect(resumeStateForMode("revise")).toBe("working");
		expect(resumeStateForMode("implement")).toBe("fixing");
		expect(resumeStateForMode("fix")).toBe("fixing");
	});
});
