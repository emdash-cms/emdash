import type { WorkflowInstanceStatus } from "cloudflare:workers";

import { dispatchAssessmentRuns, type AssessmentWorkflowBinding } from "../assessment/dispatch.js";
import type { AssessmentWorkflowParams } from "../assessment/types.js";

export type ReconciliationWorkflowPresence = "missing" | "existing" | "restartable";

export interface AssessmentWorkflowControlBinding extends AssessmentWorkflowBinding {
	get(id: string): Promise<{
		status(): Promise<{ status: WorkflowInstanceStatus }>;
		restart(): Promise<void>;
	}>;
}

export interface ReconciliationWorkflowControl {
	workflowPresence(runKey: string): Promise<ReconciliationWorkflowPresence>;
	restartWorkflow(runKey: string): Promise<void>;
}

export interface EnsuredAssessmentWorkflows {
	dispatchedRunKeys: readonly string[];
	restartedRunKeys: readonly string[];
	existingWorkflowRunKeys: readonly string[];
}

export function classifyReconciliationWorkflowStatus(
	status: WorkflowInstanceStatus,
): ReconciliationWorkflowPresence {
	switch (status) {
		case "unknown":
			return "missing";
		case "errored":
		case "terminated":
			return "restartable";
		case "queued":
		case "running":
		case "paused":
		case "complete":
		case "waiting":
		case "waitingForPause":
			return "existing";
	}
}

export function createReconciliationWorkflowControl(
	workflow: AssessmentWorkflowControlBinding,
): ReconciliationWorkflowControl {
	return {
		async workflowPresence(runKey) {
			try {
				const instance = await workflow.get(runKey);
				return classifyReconciliationWorkflowStatus((await instance.status()).status);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("(instance.not_found)")) {
					return "missing";
				}
				throw error;
			}
		},
		async restartWorkflow(runKey) {
			await (await workflow.get(runKey)).restart();
		},
	};
}

export async function ensureAssessmentWorkflowRuns(input: {
	workflow: AssessmentWorkflowBinding;
	workflowPresence(runKey: string): Promise<ReconciliationWorkflowPresence>;
	restartWorkflow(runKey: string): Promise<void>;
	runs: readonly AssessmentWorkflowParams[];
}): Promise<EnsuredAssessmentWorkflows> {
	const missing: AssessmentWorkflowParams[] = [];
	const restartable: AssessmentWorkflowParams[] = [];
	const existingWorkflowRunKeys: string[] = [];
	const restartedRunKeys: string[] = [];
	for (const run of input.runs) {
		const presence = await input.workflowPresence(run.runKey);
		if (presence === "missing") missing.push(run);
		else if (presence === "restartable") restartable.push(run);
		else if (presence === "existing") existingWorkflowRunKeys.push(run.runKey);
		else throw new TypeError("Workflow presence adapter returned an unsupported state");
	}

	for (const run of restartable) {
		const resolution = await restartOrReclassify(input, run.runKey);
		if (resolution === "restarted") restartedRunKeys.push(run.runKey);
		else if (resolution === "existing") existingWorkflowRunKeys.push(run.runKey);
		else missing.push(run);
	}

	let dispatchedRunKeys: readonly string[] = [];
	if (missing.length > 0) {
		try {
			dispatchedRunKeys = (await dispatchAssessmentRuns(input.workflow, missing)).acceptedRunKeys;
		} catch (error) {
			const stillMissing: string[] = [];
			for (const run of missing) {
				const presence = await input.workflowPresence(run.runKey);
				if (presence === "missing") {
					stillMissing.push(run.runKey);
				} else if (presence === "restartable") {
					const resolution = await restartOrReclassify(input, run.runKey);
					if (resolution === "restarted") restartedRunKeys.push(run.runKey);
					else if (resolution === "existing") existingWorkflowRunKeys.push(run.runKey);
					else stillMissing.push(run.runKey);
				} else if (presence === "existing") {
					existingWorkflowRunKeys.push(run.runKey);
				} else {
					throw new TypeError("Workflow presence adapter returned an unsupported state", {
						cause: error,
					});
				}
			}
			if (stillMissing.length > 0) throw error;
		}
	}

	return { dispatchedRunKeys, restartedRunKeys, existingWorkflowRunKeys };
}

async function restartOrReclassify(
	input: Pick<
		Parameters<typeof ensureAssessmentWorkflowRuns>[0],
		"workflowPresence" | "restartWorkflow"
	>,
	runKey: string,
): Promise<"restarted" | ReconciliationWorkflowPresence> {
	try {
		await input.restartWorkflow(runKey);
		return "restarted";
	} catch (error) {
		const presence = await input.workflowPresence(runKey);
		if (presence === "restartable") throw error;
		return presence;
	}
}
