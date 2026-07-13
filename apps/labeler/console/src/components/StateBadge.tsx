import { Badge } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

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

export interface StateBadgeProps {
	state: AssessmentState;
}

/** Renders the labeler's full internal assessment-state vocabulary — wider
 * than the public assessment API's, since an operator needs to see
 * pre-decision and inconclusive-terminal states too. */
export function StateBadge({ state }: StateBadgeProps) {
	const { t } = useLingui();
	const labels: Record<AssessmentState, string> = {
		observed: t`Observed`,
		verifying: t`Verifying`,
		pending: t`Pending`,
		running: t`Running`,
		passed: t`Passed`,
		warned: t`Warned`,
		blocked: t`Blocked`,
		error: t`Error`,
		stale: t`Stale`,
		cancelled: t`Cancelled`,
	};
	return (
		<Badge variant={VARIANT_BY_STATE[state]} appearance="dot">
			{labels[state]}
		</Badge>
	);
}
