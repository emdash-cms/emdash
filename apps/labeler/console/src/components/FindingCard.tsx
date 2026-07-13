import { Badge, LayerCard } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

import type { OperatorFinding } from "../api/types.js";
import { SeverityBadge } from "./SeverityBadge.js";

export interface FindingCardProps {
	finding: OperatorFinding;
}

/**
 * Renders a finding with the public/private field groups visually
 * separated — `publicSummary` is what a `publicAssessment` API response
 * would show; `privateDetail` and `evidenceRefs` never leave the labeler's
 * public routes (see apps/labeler/src/evidence.ts's `toPublicFinding`).
 */
export function FindingCard({ finding }: FindingCardProps) {
	const { t } = useLingui();
	return (
		<LayerCard className="flex flex-col gap-3 p-4">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<SeverityBadge severity={finding.severity} />
					<Badge variant="outline">{finding.category}</Badge>
				</div>
				<span className="text-xs text-kumo-subtle">{finding.source}</span>
			</div>
			<h3 className="font-medium">{finding.title}</h3>
			<div>
				<p className="text-xs font-semibold text-kumo-subtle uppercase tracking-wide">
					{t`Public summary`}
				</p>
				<p className="text-sm">{finding.publicSummary}</p>
			</div>
			<div className="rounded-md border border-kumo-line border-dashed bg-kumo-tint p-3">
				<p className="text-xs font-semibold text-kumo-danger uppercase tracking-wide">
					{t`Private detail — operators only`}
				</p>
				<p className="mt-1 text-sm">{finding.privateDetail}</p>
				{finding.evidenceRefs.length > 0 && (
					<p className="mt-2 text-xs text-kumo-subtle">
						{t`Evidence`}: {finding.evidenceRefs.join(", ")}
					</p>
				)}
			</div>
		</LayerCard>
	);
}
