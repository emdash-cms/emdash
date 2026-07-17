import { Badge } from "@cloudflare/kumo";

import type { ReconsiderationOutcome, ReconsiderationState } from "../api/types.js";

type BadgeVariant = "neutral" | "info" | "success" | "warning" | "error";

const STATE_VARIANT: Record<ReconsiderationState, BadgeVariant> = {
	open: "warning",
	resolved: "neutral",
};

const STATE_LABEL: Record<ReconsiderationState, string> = {
	open: "Open",
	resolved: "Resolved",
};

const OUTCOME_VARIANT: Record<ReconsiderationOutcome, BadgeVariant> = {
	granted: "success",
	denied: "error",
	withdrawn: "neutral",
};

const OUTCOME_LABEL: Record<ReconsiderationOutcome, string> = {
	granted: "Granted",
	denied: "Denied",
	withdrawn: "Withdrawn",
};

export function ReconsiderationStateBadge({ state }: { state: ReconsiderationState }) {
	return (
		<Badge variant={STATE_VARIANT[state]} appearance="dot">
			{STATE_LABEL[state]}
		</Badge>
	);
}

export function ReconsiderationOutcomeBadge({ outcome }: { outcome: ReconsiderationOutcome }) {
	return <Badge variant={OUTCOME_VARIANT[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>;
}
