import { Badge } from "@cloudflare/kumo";

import type { AssessmentState } from "../api/types.js";

type BadgeVariant = "neutral" | "info" | "success" | "warning" | "error";

const VARIANT_BY_STATE: Record<AssessmentState, BadgeVariant> = {
	observed: "neutral",
	verifying: "neutral",
	pending: "info",
	running: "info",
	passed: "success",
	warned: "warning",
	blocked: "error",
	error: "error",
	stale: "neutral",
	cancelled: "neutral",
};

const LABEL_BY_STATE: Record<AssessmentState, string> = {
	observed: "Observed",
	verifying: "Verifying",
	pending: "Pending",
	running: "Running",
	passed: "Passed",
	warned: "Warned",
	blocked: "Blocked",
	error: "Error",
	stale: "Stale",
	cancelled: "Cancelled",
};

export interface StateBadgeProps {
	state: AssessmentState;
}

/** Renders the labeler's full internal assessment-state vocabulary — wider
 * than the public assessment API's, since an operator needs to see
 * pre-decision and inconclusive-terminal states too. */
export function StateBadge({ state }: StateBadgeProps) {
	return (
		<Badge variant={VARIANT_BY_STATE[state]} appearance="dot">
			{LABEL_BY_STATE[state]}
		</Badge>
	);
}
