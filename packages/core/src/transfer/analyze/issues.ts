/**
 * Bounded blocker and warning lists for analysis.
 *
 * Issue messages are fixed strings and details carry only locations (package
 * paths, line numbers, property names, record kinds and ids) — never record
 * values. Package content is untrusted and plans, errors, and logs are shown
 * to people who did not necessarily write the package.
 */

import { z } from "zod";

import { TRANSFER_LIMITS } from "../format/limits.js";
import {
	planBlockerSchema,
	planWarningSchema,
	type PlanBlocker,
	type PlanWarning,
} from "../format/plan.js";

export const issueStateSchema = z.strictObject({
	blockers: z.array(planBlockerSchema),
	warnings: z.array(planWarningSchema),
	droppedBlockers: z.number().int().nonnegative(),
	droppedWarnings: z.number().int().nonnegative(),
});

export type IssueState = z.infer<typeof issueStateSchema>;

export function emptyIssues(): IssueState {
	return { blockers: [], warnings: [], droppedBlockers: 0, droppedWarnings: 0 };
}

export function addBlocker(issues: IssueState, blocker: PlanBlocker): void {
	if (issues.blockers.length < TRANSFER_LIMITS.planIssues) issues.blockers.push(blocker);
	else issues.droppedBlockers++;
}

export function addWarning(issues: IssueState, warning: PlanWarning): void {
	if (issues.warnings.length < TRANSFER_LIMITS.planIssues) issues.warnings.push(warning);
	else issues.droppedWarnings++;
}

/** The warnings plus an `issues_truncated` warning when either list overflowed. */
export function finalWarnings(issues: IssueState): PlanWarning[] {
	if (issues.droppedBlockers === 0 && issues.droppedWarnings === 0) return [...issues.warnings];
	return [
		...issues.warnings,
		{
			code: "issues_truncated",
			message: "More issues were found than the plan lists",
			count: issues.droppedBlockers + issues.droppedWarnings,
			detail: { blockers: issues.droppedBlockers, warnings: issues.droppedWarnings },
		},
	];
}
