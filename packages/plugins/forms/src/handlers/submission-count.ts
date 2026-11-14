import type { StorageCollection } from "emdash";

import type { FormDefinition } from "../types.js";

/**
 * Lower a form's `submissionCount` by `by`, stopping at zero.
 *
 * Each step is a single guarded update of the counter alone, so it can't overwrite an edit to the
 * form or lose a concurrent submission's increment.
 */
export async function decrementSubmissionCount(
	forms: StorageCollection<FormDefinition>,
	formId: string,
	by: number,
): Promise<void> {
	const lowered = await forms.updateIf(formId, {
		where: { submissionCount: { gte: by } },
		delta: { submissionCount: { dec: by } },
	});
	if (lowered.applied) return;
	await forms.updateIf(formId, {
		where: { submissionCount: { lt: by } },
		set: { submissionCount: 0 },
	});
}
