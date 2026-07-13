import { LayerCard, Loader, Table } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";

import { apiClient } from "../api/client.js";
import { StateBadge } from "../components/StateBadge.js";
import { shellRoute } from "./root.js";

function SubjectHistory() {
	const { uri } = subjectHistoryRoute.useParams();

	const { data: history, isLoading } = useQuery({
		queryKey: ["subject-history", uri],
		queryFn: () => apiClient.getSubjectHistory(uri),
	});

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-16">
				<Loader />
			</div>
		);
	}

	if (!history) {
		return <div className="p-8 text-center text-sm text-kumo-subtle">Subject not found.</div>;
	}

	const { subject, assessments } = history;

	return (
		<div className="flex flex-col gap-6">
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
