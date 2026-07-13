import { Badge } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

import type { FindingSeverity } from "../api/types.js";

type BadgeVariant = "neutral" | "blue" | "warning" | "orange" | "error";

const VARIANT_BY_SEVERITY: Record<FindingSeverity, BadgeVariant> = {
	critical: "error",
	high: "orange",
	medium: "warning",
	low: "blue",
	info: "neutral",
};

export interface SeverityBadgeProps {
	severity: FindingSeverity;
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
	const { t } = useLingui();
	const labels: Record<FindingSeverity, string> = {
		critical: t`Critical`,
		high: t`High`,
		medium: t`Medium`,
		low: t`Low`,
		info: t`Info`,
	};
	return <Badge variant={VARIANT_BY_SEVERITY[severity]}>{labels[severity]}</Badge>;
}
