import { describe, expect, it } from "vitest";

import { createAssessmentWorkflowParams } from "../src/assessment/run-key.js";
import type { AssessmentWorkflowParams } from "../src/assessment/types.js";
import { ensureOperatorRerunWorkflow } from "../src/operator/api.js";
import {
	classifyReconciliationWorkflowStatus,
	createReconciliationWorkflowControl,
	ensureAssessmentWorkflowRuns,
	type ReconciliationWorkflowPresence,
} from "../src/reconciliation/workflows.js";
import { ASSESSMENT_VERSIONS, PROFILE_CID, PROFILE_URI } from "./assessment-fixtures.js";

describe("Workflow recovery", () => {
	it("classifies failed terminal instances as restartable rather than healthy", () => {
		for (const status of ["errored", "terminated"] as const) {
			expect(classifyReconciliationWorkflowStatus(status)).toBe("restartable");
		}
		for (const status of [
			"queued",
			"running",
			"paused",
			"complete",
			"waiting",
			"waitingForPause",
		] as const) {
			expect(classifyReconciliationWorkflowStatus(status)).toBe("existing");
		}
		expect(classifyReconciliationWorkflowStatus("unknown")).toBe("missing");
	});

	it("maps the production Workflow not-found rejection to a missing instance", async () => {
		const control = createReconciliationWorkflowControl({
			createBatch: async () => [],
			async get() {
				throw new Error("(instance.not_found) Instance not found");
			},
		});

		await expect(control.workflowPresence("assessment-run-key")).resolves.toBe("missing");
	});

	it("does not hide other Workflow lookup failures", async () => {
		const control = createReconciliationWorkflowControl({
			createBatch: async () => [],
			async get() {
				throw new Error("Workflow service unavailable");
			},
		});

		await expect(control.workflowPresence("assessment-run-key")).rejects.toThrow(
			"Workflow service unavailable",
		);
	});

	it("restarts errored and terminated reconciliation Workflows", async () => {
		const errored = await params("errored");
		const terminated = await params("terminated");
		const states = new Map<string, ReconciliationWorkflowPresence>([
			[errored.runKey, "restartable" as const],
			[terminated.runKey, "restartable" as const],
		]);
		const restarted: string[] = [];
		const created: string[] = [];

		const result = await ensureAssessmentWorkflowRuns({
			workflow: {
				async createBatch(batch) {
					created.push(...batch.map(({ id }) => id));
					return [];
				},
			},
			workflowPresence: async (runKey) => states.get(runKey) ?? "missing",
			async restartWorkflow(runKey) {
				restarted.push(runKey);
				states.set(runKey, "existing");
			},
			runs: [errored, terminated],
		});

		expect(result).toEqual({
			dispatchedRunKeys: [],
			restartedRunKeys: [errored.runKey, terminated.runKey],
			existingWorkflowRunKeys: [],
		});
		expect(restarted).toEqual([errored.runKey, terminated.runKey]);
		expect(created).toEqual([]);
	});

	it("tolerates concurrent identical operator reruns that both observe unknown", async () => {
		const run = await params("operator-race");
		let state: "unknown" | "running" = "unknown";
		let initialReads = 0;
		let releaseInitialReads: () => void = () => undefined;
		const bothReadUnknown = new Promise<void>((resolve) => {
			releaseInitialReads = resolve;
		});
		let createAttempts = 0;
		const workflow = {
			async get() {
				return {
					async status() {
						const observed = state;
						if (observed === "unknown") {
							initialReads += 1;
							if (initialReads === 2) releaseInitialReads();
							await bothReadUnknown;
						}
						return { status: observed };
					},
					async restart() {
						state = "running";
					},
				};
			},
			async createBatch() {
				createAttempts += 1;
				if (state !== "unknown") throw new Error("Workflow instance already exists");
				state = "running";
				return [];
			},
		};

		await expect(
			Promise.all([
				ensureOperatorRerunWorkflow(workflow, run),
				ensureOperatorRerunWorkflow(workflow, run),
			]),
		).resolves.toEqual([undefined, undefined]);
		expect(createAttempts).toBe(2);
		expect(state).toBe("running");
	});

	it("does not hide a creation failure while the Workflow remains unknown", async () => {
		const run = await params("operator-create-failed");
		const workflow = {
			async get() {
				return {
					status: async () => ({ status: "unknown" as const }),
					restart: async () => undefined,
				};
			},
			async createBatch() {
				throw new Error("Workflow service unavailable");
			},
		};

		await expect(ensureOperatorRerunWorkflow(workflow, run)).rejects.toThrow(
			"Workflow service unavailable",
		);
	});
});

async function params(logicalTriggerId: string): Promise<AssessmentWorkflowParams> {
	return createAssessmentWorkflowParams({
		subject: { uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" },
		versions: ASSESSMENT_VERSIONS,
		logicalTriggerId,
	});
}
