import { Badge, LayerCard, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { apiClient } from "../api/client.js";
import { FindingCard } from "../components/FindingCard.js";
import { StateBadge } from "../components/StateBadge.js";
import { shellRoute } from "./root.js";

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-xs text-kumo-subtle">{label}</span>
			<span className="text-sm">{value}</span>
		</div>
	);
}

function AssessmentDetail() {
	const { t } = useLingui();
	const { id } = assessmentDetailRoute.useParams();

	const { data: assessment, isLoading: isLoadingAssessment } = useQuery({
		queryKey: ["assessment", id],
		queryFn: () => apiClient.getAssessment(id),
	});
	const { data: findings, isLoading: isLoadingFindings } = useQuery({
		queryKey: ["assessment", id, "findings"],
		queryFn: () => apiClient.listFindings(id),
		enabled: !!assessment,
	});
	const { data: labels, isLoading: isLoadingLabels } = useQuery({
		queryKey: ["assessment", id, "labels"],
		queryFn: () => apiClient.listLabels(id),
		enabled: !!assessment,
	});

	if (isLoadingAssessment) {
		return (
			<div className="flex items-center justify-center py-16">
				<Loader />
			</div>
		);
	}

	if (!assessment) {
		return (
			<div className="p-8 text-center text-sm text-kumo-subtle">{t`Assessment not found.`}</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<h1 className="text-xl font-semibold">{t`Assessment`}</h1>
					<StateBadge state={assessment.state} />
					{assessment.isSuperseded && <Badge variant="neutral">{t`Superseded`}</Badge>}
				</div>
				<Link
					to="/subjects/$uri"
					params={{ uri: assessment.uri }}
					className="font-mono text-sm text-kumo-link hover:underline"
				>
					{assessment.uri}
				</Link>
				<p className="text-sm text-kumo-subtle">
					{t`CID`}: <span className="font-mono">{assessment.cid}</span>
				</p>
				{assessment.publicSummary && <p className="text-sm">{assessment.publicSummary}</p>}
			</div>

			<LayerCard className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
				<MetaRow label={t`Trigger`} value={assessment.trigger} />
				<MetaRow label={t`Policy version`} value={assessment.policyVersion} />
				<MetaRow label={t`Model`} value={assessment.modelId ?? t`None`} />
				<MetaRow label={t`Created`} value={new Date(assessment.createdAt).toLocaleString()} />
				<MetaRow
					label={t`Started`}
					value={assessment.startedAt ? new Date(assessment.startedAt).toLocaleString() : t`—`}
				/>
				<MetaRow
					label={t`Completed`}
					value={assessment.completedAt ? new Date(assessment.completedAt).toLocaleString() : t`—`}
				/>
				{assessment.supersedesAssessmentId && (
					<MetaRow
						label={t`Supersedes`}
						value={
							<Link
								to="/assessments/$id"
								params={{ id: assessment.supersedesAssessmentId }}
								className="text-kumo-link hover:underline"
							>
								{assessment.supersedesAssessmentId}
							</Link>
						}
					/>
				)}
			</LayerCard>

			<section className="flex flex-col gap-3">
				<h2 className="text-lg font-semibold">{t`Labels`}</h2>
				{isLoadingLabels || !labels ? (
					<Loader />
				) : labels.length === 0 ? (
					<p className="text-sm text-kumo-subtle">{t`No labels issued for this run.`}</p>
				) : (
					<div className="flex flex-wrap gap-2">
						{labels.map((label) => (
							<Badge
								key={`${label.val}-${label.sequence}`}
								variant={label.neg ? "neutral" : "info"}
							>
								{label.val}
							</Badge>
						))}
					</div>
				)}
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-lg font-semibold">{t`Findings`}</h2>
				{isLoadingFindings || !findings ? (
					<Loader />
				) : findings.length === 0 ? (
					<p className="text-sm text-kumo-subtle">{t`No findings recorded for this run.`}</p>
				) : (
					<div className="flex flex-col gap-3">
						{findings.map((finding) => (
							<FindingCard key={finding.id} finding={finding} />
						))}
					</div>
				)}
			</section>
		</div>
	);
}

export const assessmentDetailRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/assessments/$id",
	component: AssessmentDetail,
});
