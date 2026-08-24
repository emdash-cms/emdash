import { describe, expect, test } from "vitest";

import {
	BOOTSTRAP_TIMEOUT_MS,
	CONTAINER_PREPARE_TIMEOUT_MS,
	DEADLINE_WARNING_LEAD_MS,
	DEADLINE_WARNING_MESSAGE,
	FLUE_RUN_TIMEOUT_MS,
	SANDBOX_SLEEP_AFTER_SECONDS,
	runBudgetMs,
	runSchedule,
} from "../../.flue/lib/run-policy.js";

describe("run lifecycle policy", () => {
	test("selects a 30-minute read budget and a 60-minute write budget", () => {
		expect(runBudgetMs("diagnose")).toBe(30 * 60_000);
		expect(runBudgetMs("repro")).toBe(30 * 60_000);

		for (const mode of ["implement", "fix", "revise"] as const) {
			expect(runBudgetMs(mode)).toBe(60 * 60_000);
		}
	});

	test("keeps the Flue ceiling and sandbox sleep beyond every per-mode deadline", () => {
		for (const mode of ["diagnose", "repro", "implement", "fix", "revise"] as const) {
			expect(FLUE_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(runBudgetMs(mode));
			expect(SANDBOX_SLEEP_AFTER_SECONDS * 1_000).toBeGreaterThan(runBudgetMs(mode));
		}
		expect(CONTAINER_PREPARE_TIMEOUT_MS).toBe(BOOTSTRAP_TIMEOUT_MS + 10 * 60_000);
		expect(FLUE_RUN_TIMEOUT_MS).toBeGreaterThan(
			runBudgetMs("implement") + CONTAINER_PREPARE_TIMEOUT_MS,
		);
		expect(SANDBOX_SLEEP_AFTER_SECONDS * 1_000).toBe(FLUE_RUN_TIMEOUT_MS + 5 * 60_000);
	});

	test("schedules one write-mode warning ten minutes before the unchanged deadline", () => {
		const startedAt = 1_000_000;
		const beforeWarning = runSchedule("implement", startedAt, false);
		expect(beforeWarning.warningAt).toBe(
			startedAt + runBudgetMs("implement") - DEADLINE_WARNING_LEAD_MS,
		);
		expect(beforeWarning.nextAlarmAt).toBe(beforeWarning.warningAt);

		const afterWarning = runSchedule("implement", startedAt, true);
		expect(afterWarning.warningAt).toBeNull();
		expect(afterWarning.deadlineAt).toBe(beforeWarning.deadlineAt);
		expect(afterWarning.nextAlarmAt).toBe(beforeWarning.deadlineAt);
	});

	test("does not schedule deadline warnings for read modes", () => {
		for (const mode of ["diagnose", "repro"] as const) {
			const schedule = runSchedule(mode, 5_000, false);
			expect(schedule.warningAt).toBeNull();
			expect(schedule.nextAlarmAt).toBe(schedule.deadlineAt);
		}
	});

	test("warns the agent to finish, verify, publish, and report without extending the run", () => {
		expect(DEADLINE_WARNING_MESSAGE).toContain("Stop broad investigation");
		expect(DEADLINE_WARNING_MESSAGE).toContain("smallest correct change");
		expect(DEADLINE_WARNING_MESSAGE).toContain("required verification");
		expect(DEADLINE_WARNING_MESSAGE).toContain("publish and report");
		expect(DEADLINE_WARNING_MESSAGE).toContain("partial or failure outcome");
		expect(DEADLINE_WARNING_MESSAGE).toContain("does not extend the deadline");
	});
});
