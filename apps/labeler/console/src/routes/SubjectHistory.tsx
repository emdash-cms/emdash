import { Button, LayerCard, Loader, Table } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { apiClient } from "../api/client.js";
import type { IssuableLabel } from "../api/types.js";
import { LabelActionDialog } from "../components/LabelActionDialog.js";
import { QueryError } from "../components/QueryError.js";
import { StateBadge } from "../components/StateBadge.js";
import { PACKAGE_ISSUABLE_LABELS, RELEASE_ISSUABLE_LABELS } from "../labels.js";
import { shellRoute } from "./root.js";

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
	const [issueOpen, setIssueOpen] = useState(false);

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
