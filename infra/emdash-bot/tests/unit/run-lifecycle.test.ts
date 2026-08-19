import { describe, expect, test } from "vitest";

import {
	advanceRunLifecycle,
	beginRunLifecycle,
	resumeRunLifecycle,
	runMachineSnapshot,
	runPlan,
	settleRunLifecycle,
	startRunLifecycle,
} from "../../.flue/lib/run-lifecycle.js";

describe("run lifecycle", () => {
	test("direct implementation skips reproduction and diagnosis", () => {
		expect(runPlan("implement")).toEqual([
			"prepare",
			"edit",
			"finalize",
			"verify",
			"publish",
			"report",
		]);
		expect(runPlan("implement")).not.toContain("reproduce");
		expect(runPlan("implement")).not.toContain("diagnose");
	});

	test("investigation and repro choose different branches", () => {
		expect(runPlan("diagnose")).toEqual(["prepare", "reproduce", "diagnose", "report"]);
		expect(runPlan("repro")).toEqual([
			"prepare",
			"reproduce",
			"diagnose",
			"edit",
			"finalize",
			"verify",
			"publish",
			"report",
		]);
	});

	test("advances observable phases and retains the completed run", () => {
		const started = startRunLifecycle({ runId: "run-1", mode: "implement", startedAt: 1_000 });
		expect(started).toMatchObject({
			status: "running",
			phase: "prepare",
			attempt: 1,
			deadlineAt: 1_000 + 60 * 60_000,
		});

		const editing = advanceRunLifecycle(started, "workspace_ready");
		expect(editing.phase).toBe("edit");
		const verifying = advanceRunLifecycle(editing, "verification_passed");
		expect(verifying.phase).toBe("verify");
		const publishing = advanceRunLifecycle(verifying, "candidate_publishing");
		expect(publishing.phase).toBe("publish");
		const reporting = advanceRunLifecycle(publishing, "candidate_published");
		expect(reporting.phase).toBe("report");

		expect(settleRunLifecycle(reporting, "succeeded", 5_000)).toMatchObject({
			status: "succeeded",
			phase: "report",
			completedAt: 5_000,
		});
	});

	test("starts the agent deadline after workspace bootstrap without changing creation time", () => {
		const admitted = startRunLifecycle({ runId: "run-1", mode: "implement", startedAt: 1_000 });
		const started = beginRunLifecycle(admitted, 10_000);

		expect(started).toMatchObject({
			createdAt: 1_000,
			startedAt: 10_000,
			deadlineAt: 10_000 + 60 * 60_000,
			phase: "prepare",
		});
	});

	test("resume keeps the plan and phase while starting a new attempt budget", () => {
		const started = startRunLifecycle({ runId: "run-1", mode: "fix", startedAt: 1_000 });
		const timedOut = settleRunLifecycle(
			advanceRunLifecycle(started, "verification_passed"),
			"timed_out",
			2_000,
		);
		const resumed = resumeRunLifecycle(timedOut, 3_000);

		expect(resumed).toMatchObject({
			status: "running",
			phase: "verify",
			attempt: 2,
			startedAt: 3_000,
			completedAt: null,
		});
		expect(resumed.plan).toEqual(timedOut.plan);
	});

	test("records a human-cancelled run without advancing its phase", () => {
		const started = advanceRunLifecycle(
			startRunLifecycle({ runId: "run-1", mode: "implement", startedAt: 1_000 }),
			"workspace_ready",
		);
		expect(settleRunLifecycle(started, "cancelled", 2_000)).toMatchObject({
			status: "cancelled",
			phase: "edit",
			completedAt: 2_000,
		});
	});

	test("serializes the run machine for the dashboard", () => {
		const snapshot = runMachineSnapshot();
		expect(snapshot.phases.map((phase) => phase.id)).toEqual([
			"prepare",
			"reproduce",
			"diagnose",
			"edit",
			"finalize",
			"verify",
			"publish",
			"report",
		]);
		expect(snapshot.statuses).toContain("cancelled");
		expect(snapshot.plans.implement).toEqual(runPlan("implement"));
	});
});
