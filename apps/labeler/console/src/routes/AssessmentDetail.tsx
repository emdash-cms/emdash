import { Badge, Button, LayerCard, Loader } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { apiClient } from "../api/client.js";
import type { IssuableLabel } from "../api/types.js";
import { AssessmentActionDialog } from "../components/AssessmentActionDialog.js";
import { FindingCard } from "../components/FindingCard.js";
import { LabelActionDialog } from "../components/LabelActionDialog.js";
import { OverrideDialog } from "../components/OverrideDialog.js";
import { QueryError } from "../components/QueryError.js";
import { StateBadge } from "../components/StateBadge.js";
import {
	isAutomatedBlock,
	isReleaseRetractable,
	RELEASE_ISSUABLE_LABELS,
	releaseLabelScope,
} from "../labels.js";
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
	const { id } = assessmentDetailRoute.useParams();

	const {
		data: assessment,
		isLoading: isLoadingAssessment,
		isError: isAssessmentError,
		error: assessmentError,
	} = useQuery({
		queryKey: ["assessment", id],
		queryFn: () => apiClient.getAssessment(id),
	});
	const {
		data: findings,
		isLoading: isLoadingFindings,
		isError: isFindingsError,
		error: findingsError,
	} = useQuery({
		queryKey: ["assessment", id, "findings"],
		queryFn: () => apiClient.listFindings(id),
		enabled: !!assessment,
	});
	const {
		data: labels,
		isLoading: isLoadingLabels,
		isError: isLabelsError,
		error: labelsError,
	} = useQuery({
		queryKey: ["assessment", id, "labels"],
		queryFn: () => apiClient.listLabels(id),
		enabled: !!assessment,
	});
	const { data: whoami } = useQuery({ queryKey: ["whoami"], queryFn: () => apiClient.whoami() });
	const canAct = whoami?.roles.includes("reviewer") || whoami?.roles.includes("admin") || false;

	const subjectUri = assessment?.uri;
	const subjectCid = assessment?.cid;
	const { data: subjectLabels } = useQuery({
		queryKey: ["subject-labels", subjectUri, subjectCid],
		queryFn: () => apiClient.getSubjectLabels(subjectUri!, subjectCid),
		enabled: !!subjectUri,
	});

	const [issueOpen, setIssueOpen] = useState(false);
	const [retractTarget, setRetractTarget] = useState<IssuableLabel | null>(null);
	const [rerunOpen, setRerunOpen] = useState(false);
	const [overrideOpen, setOverrideOpen] = useState(false);
	const [overrideRetractOpen, setOverrideRetractOpen] = useState(false);

	if (isAssessmentError) {
		return <QueryError title="Failed to load assessment" error={assessmentError} />;
	}

	if (isLoadingAssessment) {
		return (
			<div className="flex items-center justify-center py-16">
				<Loader />
			</div>
		);
	}

	// A successful query that resolved to null is a genuine not-found, distinct
	// from isAssessmentError above -- that branch already returned.
	if (!assessment) {
		return <div className="p-8 text-center text-sm text-kumo-subtle">Assessment not found.</div>;
	}

	const activeSubjectLabels = subjectLabels ?? [];
	const activeBlocks = activeSubjectLabels
		.filter((label) => label.active && isAutomatedBlock(label.val))
		.map((label) => label.val);
	const hasActiveOverride = activeSubjectLabels.some(
		(label) => label.val === "assessment-overridden" && label.active,
	);
	const actionInvalidateKeys: readonly (readonly unknown[])[] = [
		["assessment", id, "labels"],
		["assessment", id],
		["subject-labels", assessment.uri, assessment.cid],
	];

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<h1 className="text-xl font-semibold">Assessment</h1>
					<StateBadge state={assessment.state} />
					{assessment.isSuperseded && <Badge variant="neutral">Superseded</Badge>}
				</div>
				<Link
					to="/subjects/$uri"
					params={{ uri: assessment.uri }}
					className="font-mono text-sm text-kumo-link hover:underline"
				>
					{assessment.uri}
				</Link>
				<p className="text-sm text-kumo-subtle">
					CID: <span className="font-mono">{assessment.cid}</span>
				</p>
				{assessment.publicSummary && <p className="text-sm">{assessment.publicSummary}</p>}
			</div>

			<LayerCard className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
				<MetaRow label="Trigger" value={assessment.trigger} />
				<MetaRow label="Policy version" value={assessment.policyVersion} />
				<MetaRow label="Model" value={assessment.modelId ?? "None"} />
				<MetaRow label="Created" value={new Date(assessment.createdAt).toLocaleString()} />
				<MetaRow
					label="Started"
					value={assessment.startedAt ? new Date(assessment.startedAt).toLocaleString() : "—"}
				/>
				<MetaRow
					label="Completed"
					value={assessment.completedAt ? new Date(assessment.completedAt).toLocaleString() : "—"}
				/>
				{assessment.supersedesAssessmentId && (
					<MetaRow
						label="Supersedes"
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

			{canAct && (
				<div className="flex flex-wrap gap-2">
					<Button variant="secondary" onClick={() => setRerunOpen(true)}>
						Rerun
					</Button>
					{activeBlocks.length > 0 && (
						<Button variant="secondary" onClick={() => setOverrideOpen(true)}>
							Override (unblock)
						</Button>
					)}
					{hasActiveOverride && (
						<Button variant="destructive" onClick={() => setOverrideRetractOpen(true)}>
							Retract override
						</Button>
					)}
				</div>
			)}

			<section className="flex flex-col gap-3">
				<h2 className="text-lg font-semibold">Active labels for this release</h2>
				{activeSubjectLabels.length === 0 ? (
					<p className="text-sm text-kumo-subtle">No active labels for this release.</p>
				) : (
					<div className="flex flex-wrap gap-2">
						{activeSubjectLabels.map((label) => (
							<Badge
								key={`${label.val}-${label.sequence}`}
								variant={label.active ? "info" : "neutral"}
							>
								{label.val}
								{!label.active && (label.neg ? " (retracted)" : " (inactive)")}
							</Badge>
						))}
					</div>
				)}
			</section>

			<section className="flex flex-col gap-3">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-semibold">Labels issued by this run</h2>
					{canAct && (
						<Button variant="secondary" onClick={() => setIssueOpen(true)}>
							Issue label
						</Button>
					)}
				</div>
				{isLabelsError ? (
					<QueryError title="Failed to load labels" error={labelsError} />
				) : isLoadingLabels || !labels ? (
					<Loader />
				) : labels.length === 0 ? (
					<p className="text-sm text-kumo-subtle">No labels issued for this run.</p>
				) : (
					<div className="flex flex-wrap gap-2">
						{labels.map((label) => (
							<div key={`${label.val}-${label.sequence}`} className="flex items-center gap-1">
								<Badge variant={label.neg ? "neutral" : "info"}>{label.val}</Badge>
								{canAct && !label.neg && isReleaseRetractable(label.val) && (
									<Button
										variant="ghost"
										size="sm"
										aria-label={`Retract ${label.val}`}
										onClick={() =>
											setRetractTarget({ val: label.val, scope: releaseLabelScope(label.val) })
										}
									>
										Retract
									</Button>
								)}
							</div>
						))}
					</div>
				)}
			</section>

			{canAct && (
				<>
					<LabelActionDialog
						open={issueOpen}
						onOpenChange={setIssueOpen}
						mode="issue"
						subjectUri={assessment.uri}
						subjectCid={assessment.cid}
						issuable={RELEASE_ISSUABLE_LABELS}
						invalidateKeys={actionInvalidateKeys}
					/>
					<LabelActionDialog
						open={retractTarget !== null}
						onOpenChange={(open) => {
							if (!open) setRetractTarget(null);
						}}
						mode="retract"
						subjectUri={assessment.uri}
						subjectCid={assessment.cid}
						{...(retractTarget ? { target: retractTarget } : {})}
						invalidateKeys={actionInvalidateKeys}
					/>
					<AssessmentActionDialog
						open={rerunOpen}
						onOpenChange={setRerunOpen}
						mode="rerun"
						assessmentId={id}
						subjectUri={assessment.uri}
						subjectCid={assessment.cid}
						invalidateKeys={actionInvalidateKeys}
					/>
					<OverrideDialog
						open={overrideOpen}
						onOpenChange={setOverrideOpen}
						assessmentId={id}
						subjectUri={assessment.uri}
						subjectCid={assessment.cid}
						blocks={activeBlocks}
						invalidateKeys={actionInvalidateKeys}
					/>
					<AssessmentActionDialog
						open={overrideRetractOpen}
						onOpenChange={setOverrideRetractOpen}
						mode="override-retract"
						assessmentId={id}
						subjectUri={assessment.uri}
						subjectCid={assessment.cid}
						invalidateKeys={actionInvalidateKeys}
					/>
				</>
			)}

			<section className="flex flex-col gap-3">
				<h2 className="text-lg font-semibold">Findings</h2>
				{isFindingsError ? (
					<QueryError title="Failed to load findings" error={findingsError} />
				) : isLoadingFindings || !findings ? (
					<Loader />
				) : findings.length === 0 ? (
					<p className="text-sm text-kumo-subtle">No findings recorded for this run.</p>
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
