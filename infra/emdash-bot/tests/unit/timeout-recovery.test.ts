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

	test("summary prompt carries known verification evidence without offering more work", () => {
		const prompt = buildTimeoutSummaryPrompt({
			mode: "implement",
			verification: [
				{ name: "typecheck", command: "pnpm typecheck", exitCode: 0 },
				{ name: "test", command: "pnpm test", exitCode: 1 },
			],
			lastFailure: { stage: "verification", message: "test failed with exit 1" },
		});

		expect(prompt).toContain("No tools are available");
		expect(prompt).toContain("typecheck: passed");
		expect(prompt).toContain("test: failed (exit 1)");
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
