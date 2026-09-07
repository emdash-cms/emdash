import type { AssessmentWorkflowParams } from "./types.js";

const MAX_BATCH_SIZE = 100;
const MAX_RUN_KEY_LENGTH = 100;

export interface AssessmentDispatchResult {
	acceptedRunKeys: string[];
}

export interface AssessmentWorkflowBinding {
	createBatch(
		batch: Array<{ id: string; params: AssessmentWorkflowParams }>,
	): Promise<readonly unknown[]>;
}

export async function dispatchAssessmentRuns(
	workflow: AssessmentWorkflowBinding,
	runs: readonly AssessmentWorkflowParams[],
): Promise<AssessmentDispatchResult> {
	if (runs.length > MAX_BATCH_SIZE) {
		throw new RangeError(`assessment batches must contain at most ${MAX_BATCH_SIZE} runs`);
	}
	if (runs.length === 0) {
		return { acceptedRunKeys: [] };
	}

	const acceptedRunKeys = runs.map(({ runKey }) => {
		if (runKey.length === 0 || runKey.length > MAX_RUN_KEY_LENGTH) {
			throw new RangeError(
				`assessment run keys must contain between 1 and ${MAX_RUN_KEY_LENGTH} characters`,
			);
		}
		return runKey;
	});
	if (new Set(acceptedRunKeys).size !== acceptedRunKeys.length) {
		throw new TypeError("assessment batches must not contain duplicate run keys");
	}

	await workflow.createBatch(
		runs.map((params) => ({
			id: params.runKey,
			params,
		})),
	);

	return { acceptedRunKeys };
}
