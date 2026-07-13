import { Badge } from "@cloudflare/kumo";

import type { FindingSeverity } from "../api/types.js";

type BadgeVariant = "neutral" | "blue" | "warning" | "orange" | "error";

const VARIANT_BY_SEVERITY: Record<FindingSeverity, BadgeVariant> = {
	critical: "error",
	high: "orange",
	medium: "warning",
	low: "blue",
	info: "neutral",
};

const LABEL_BY_SEVERITY: Record<FindingSeverity, string> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	info: "Info",
};

export interface SeverityBadgeProps {
	severity: FindingSeverity;
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
	return <Badge variant={VARIANT_BY_SEVERITY[severity]}>{LABEL_BY_SEVERITY[severity]}</Badge>;
}
