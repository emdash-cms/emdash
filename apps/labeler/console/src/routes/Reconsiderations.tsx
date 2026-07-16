import { LayerCard, Loader, Table } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";

import { apiClient } from "../api/client.js";
import { QueryError } from "../components/QueryError.js";
import {
	ReconsiderationOutcomeBadge,
	ReconsiderationStateBadge,
} from "../components/ReconsiderationBadges.js";
import { reconsiderationActorName } from "../reconsiderations.js";
import { shellRoute } from "./root.js";

function Reconsiderations() {
	const { data, isLoading, isError, error } = useQuery({
		queryKey: ["reconsiderations"],
		queryFn: () => apiClient.listReconsiderations(),
	});

	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-xl font-semibold">Reconsiderations</h1>
			<p className="text-sm text-kumo-subtle">
				Cases where a publisher has asked reviewers to reconsider an assessment. Open a case from an
				assessment; resolve it granted, denied, or withdrawn.
			</p>

			{isError ? (
				<QueryError title="Failed to load reconsiderations" error={error} />
			) : (
				<LayerCard className="p-0">
					{isLoading || !data ? (
						<div className="flex items-center justify-center py-16">
							<Loader />
						</div>
					) : data.items.length === 0 ? (
						<div className="p-8 text-center text-sm text-kumo-subtle">No reconsiderations.</div>
					) : (
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>Subject</Table.Head>
									<Table.Head>State</Table.Head>
									<Table.Head>Outcome</Table.Head>
									<Table.Head>Opened</Table.Head>
									<Table.Head>Resolved</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{data.items.map((recon) => (
									<Table.Row key={recon.id}>
										<Table.Cell>
											<Link
												to="/reconsiderations/$id"
												params={{ id: recon.id }}
												className="font-mono font-medium text-kumo-link hover:underline"
												title={recon.subjectUri}
											>
												{recon.subjectUri.split("/").pop()}
											</Link>
										</Table.Cell>
										<Table.Cell>
											<ReconsiderationStateBadge state={recon.state} />
										</Table.Cell>
										<Table.Cell>
											{recon.outcome ? (
												<ReconsiderationOutcomeBadge outcome={recon.outcome} />
											) : (
												<span className="text-sm text-kumo-subtle">—</span>
											)}
										</Table.Cell>
										<Table.Cell>
											<span className="block text-sm">
												{reconsiderationActorName({
													email: recon.openedByEmail,
													commonName: recon.openedByCommonName,
													id: recon.openedById,
												})}
											</span>
											<span className="block text-sm text-kumo-subtle">
												{new Date(recon.openedAt).toLocaleString()}
											</span>
										</Table.Cell>
										<Table.Cell>
											{recon.resolvedAt ? (
												<>
													<span className="block text-sm">
														{reconsiderationActorName({
															email: recon.resolvedByEmail,
															commonName: recon.resolvedByCommonName,
															id: recon.resolvedById ?? "",
														})}
													</span>
													<span className="block text-sm text-kumo-subtle">
														{new Date(recon.resolvedAt).toLocaleString()}
													</span>
												</>
											) : (
												<span className="text-sm text-kumo-subtle">—</span>
											)}
										</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
					)}
				</LayerCard>
			)}
		</div>
	);
}

export const reconsiderationsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/reconsiderations",
	component: Reconsiderations,
});
