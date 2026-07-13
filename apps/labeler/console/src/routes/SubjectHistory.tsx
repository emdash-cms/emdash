import { Button, LayerCard, Loader, Table } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { apiClient } from "../api/client.js";
import type { EmergencyActionKind, IssuableLabel, SubjectLabel } from "../api/types.js";
import { EmergencyActionDialog } from "../components/EmergencyActionDialog.js";
import { LabelActionDialog } from "../components/LabelActionDialog.js";
import { QueryError } from "../components/QueryError.js";
import { StateBadge } from "../components/StateBadge.js";
import { PACKAGE_ISSUABLE_LABELS, RELEASE_ISSUABLE_LABELS } from "../labels.js";
import { shellRoute } from "./root.js";

/** A publisher's typed confirmation is its DID's final `:`-segment. */
function didFinalSegment(did: string): string {
	return did.split(":").at(-1) ?? "";
}

function isLabelActive(labels: readonly SubjectLabel[] | undefined, val: string): boolean {
	return (labels ?? []).some((label) => label.val === val && label.active);
}

interface EmergencyTarget {
	kind: EmergencyActionKind;
	mode: "issue" | "retract";
	uri: string;
	confirm: string;
}

/** URI-wide (record-level) issuable labels for a subject, chosen by its
 * collection: a release record can be security-yanked, a package profile can be
 * disputed. Presentation only — the server enforces policy. */
function uriWideLabelsFor(collection: string): readonly IssuableLabel[] {
	if (collection.endsWith(".release"))
		return RELEASE_ISSUABLE_LABELS.filter((entry) => entry.scope === "uri-wide");
	if (collection.endsWith(".profile")) return PACKAGE_ISSUABLE_LABELS;
	return [];
}

function SubjectHistory() {
	const { uri } = subjectHistoryRoute.useParams();

	const {
		data: history,
		isLoading,
		isError,
		error,
	} = useQuery({
		queryKey: ["subject-history", uri],
		queryFn: () => apiClient.getSubjectHistory(uri),
	});
	const { data: whoami } = useQuery({ queryKey: ["whoami"], queryFn: () => apiClient.whoami() });
	const canAct = whoami?.roles.includes("reviewer") || whoami?.roles.includes("admin") || false;
	const isAdmin = whoami?.roles.includes("admin") ?? false;

	const subjectRecord = history?.subject;
	const { data: recordLabels } = useQuery({
		queryKey: ["subject-labels", subjectRecord?.uri, subjectRecord?.cid],
		queryFn: () => apiClient.getSubjectLabels(subjectRecord!.uri, subjectRecord!.cid),
		enabled: isAdmin && !!subjectRecord,
	});
	const { data: publisherLabels } = useQuery({
		queryKey: ["publisher-labels", subjectRecord?.did],
		queryFn: () => apiClient.getSubjectLabels(subjectRecord!.did),
		enabled: isAdmin && !!subjectRecord,
	});

	const [issueOpen, setIssueOpen] = useState(false);
	const [emergency, setEmergency] = useState<EmergencyTarget | null>(null);

	if (isError) {
		return <QueryError title="Failed to load subject history" error={error} />;
	}

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-16">
				<Loader />
			</div>
		);
	}

	// A successful query that resolved to null is a genuine not-found, distinct
	// from isError above -- that branch already returned.
	if (!history) {
		return <div className="p-8 text-center text-sm text-kumo-subtle">Subject not found.</div>;
	}

	const { subject, assessments } = history;
	const uriWideLabels = uriWideLabelsFor(subject.collection);
	const publisherSegment = didFinalSegment(subject.did);
	const recordTakenDown = isLabelActive(recordLabels, "!takedown");
	const publisherTakenDown = isLabelActive(publisherLabels, "!takedown");
	const publisherCompromised = isLabelActive(publisherLabels, "publisher-compromised");
	const emergencyInvalidateKeys: readonly (readonly unknown[])[] = [
		["subject-history", uri],
		["subject-labels", subject.uri, subject.cid],
		["publisher-labels", subject.did],
	];

	return (
		<div className="flex flex-col gap-6">
			<div className="flex items-start justify-between gap-4">
				<div className="flex flex-col gap-1">
					<h1 className="text-xl font-semibold">Subject history</h1>
					<p className="font-mono text-sm">{subject.uri}</p>
					<p className="text-sm text-kumo-subtle">
						Current CID: <span className="font-mono">{subject.cid}</span>
					</p>
					{subject.deletedAt && (
						<p className="text-sm text-kumo-danger">
							Deleted at {new Date(subject.deletedAt).toLocaleString()}
						</p>
					)}
				</div>
				{canAct && uriWideLabels.length > 0 && (
					<Button variant="secondary" onClick={() => setIssueOpen(true)}>
						Issue record label
					</Button>
				)}
			</div>

			{isAdmin && (
				<LayerCard className="flex flex-col gap-3 border border-kumo-danger p-4">
					<div className="flex items-center gap-2">
						<h2 className="text-lg font-semibold text-kumo-danger">Emergency actions</h2>
						{recordTakenDown && (
							<span className="text-sm text-kumo-danger">This record is taken down.</span>
						)}
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							variant={recordTakenDown ? "secondary" : "destructive"}
							onClick={() =>
								setEmergency({
									kind: "takedown",
									mode: recordTakenDown ? "retract" : "issue",
									uri: subject.uri,
									confirm: subject.rkey,
								})
							}
						>
							{recordTakenDown ? "Retract record takedown" : "Take down record"}
						</Button>
						<Button
							variant={publisherTakenDown ? "secondary" : "destructive"}
							onClick={() =>
								setEmergency({
									kind: "takedown",
									mode: publisherTakenDown ? "retract" : "issue",
									uri: subject.did,
									confirm: publisherSegment,
								})
							}
						>
							{publisherTakenDown ? "Retract publisher takedown" : "Take down publisher"}
						</Button>
						<Button
							variant={publisherCompromised ? "secondary" : "destructive"}
							onClick={() =>
								setEmergency({
									kind: "publisher-compromised",
									mode: publisherCompromised ? "retract" : "issue",
									uri: subject.did,
									confirm: publisherSegment,
								})
							}
						>
							{publisherCompromised
								? "Retract publisher-compromised"
								: "Mark publisher compromised"}
						</Button>
					</div>
				</LayerCard>
			)}

			{emergency && (
				<EmergencyActionDialog
					open
					onOpenChange={(open) => {
						if (!open) setEmergency(null);
					}}
					kind={emergency.kind}
					mode={emergency.mode}
					subjectUri={emergency.uri}
					subjectConfirmationExpected={emergency.confirm}
					invalidateKeys={emergencyInvalidateKeys}
				/>
			)}

			{canAct && uriWideLabels.length > 0 && (
				<LabelActionDialog
					open={issueOpen}
					onOpenChange={setIssueOpen}
					mode="issue"
					subjectUri={subject.uri}
					subjectCid={subject.cid}
					issuable={uriWideLabels}
					invalidateKeys={[["subject-history", uri]]}
				/>
			)}

			<LayerCard className="p-0">
				{assessments.length === 0 ? (
					<div className="p-8 text-center text-sm text-kumo-subtle">
						No assessments recorded for this subject.
					</div>
				) : (
					<Table>
						<Table.Header>
							<Table.Row>
								<Table.Head>CID</Table.Head>
								<Table.Head>State</Table.Head>
								<Table.Head>Trigger</Table.Head>
								<Table.Head>Created</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{assessments.map((assessment) => (
								<Table.Row key={assessment.id}>
									<Table.Cell>
										<Link
											to="/assessments/$id"
											params={{ id: assessment.id }}
											className="font-mono text-xs text-kumo-link hover:underline"
										>
											{assessment.cid.slice(0, 16)}…
										</Link>
									</Table.Cell>
									<Table.Cell>
										<StateBadge state={assessment.state} />
									</Table.Cell>
									<Table.Cell>{assessment.trigger}</Table.Cell>
									<Table.Cell>{new Date(assessment.createdAt).toLocaleString()}</Table.Cell>
								</Table.Row>
							))}
						</Table.Body>
					</Table>
				)}
			</LayerCard>
		</div>
	);
}

export const subjectHistoryRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/subjects/$uri",
	component: SubjectHistory,
});
