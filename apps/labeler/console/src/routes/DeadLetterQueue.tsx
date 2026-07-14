import { Badge, LayerCard, Loader, Table } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";

import { apiClient } from "../api/client.js";
import type { DeadLetterStatus } from "../api/types.js";
import { DeadLetterActions } from "../components/DeadLetterActions.js";
import { QueryError } from "../components/QueryError.js";
import { shellRoute } from "./root.js";

type BadgeVariant = "neutral" | "info" | "success" | "warning" | "error";

const STATUS_VARIANT: Record<DeadLetterStatus, BadgeVariant> = {
	new: "warning",
	retried: "info",
	quarantined: "neutral",
};

const STATUS_LABEL: Record<DeadLetterStatus, string> = {
	new: "New",
	retried: "Retried",
	quarantined: "Quarantined",
};

function DeadLetterQueue() {
	const { data, isLoading, isError, error } = useQuery({
		queryKey: ["dead-letters"],
		queryFn: () => apiClient.listDeadLetters(),
	});
	const { data: whoami } = useQuery({ queryKey: ["whoami"], queryFn: () => apiClient.whoami() });
	const isAdmin = whoami?.roles.includes("admin") ?? false;

	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-xl font-semibold">Dead-letter queue</h1>
			<p className="text-sm text-kumo-subtle">
				Discovery events that failed verification. Retry re-drives an event through the consumer;
				quarantine marks it reviewed and excludes it from retry.
			</p>

			{isError ? (
				<QueryError title="Failed to load dead letters" error={error} />
			) : (
				<LayerCard className="p-0">
					{isLoading || !data ? (
						<div className="flex items-center justify-center py-16">
							<Loader />
						</div>
					) : data.items.length === 0 ? (
						<div className="p-8 text-center text-sm text-kumo-subtle">No dead letters.</div>
					) : (
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>Subject</Table.Head>
									<Table.Head>Reason</Table.Head>
									<Table.Head>Status</Table.Head>
									<Table.Head>Received</Table.Head>
									<Table.Head>Actions</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{data.items.map((letter) => (
									<Table.Row key={letter.id}>
										<Table.Cell>
											<span
												className="font-mono"
												title={`at://${letter.did}/${letter.collection}/${letter.rkey}`}
											>
												{letter.rkey}
											</span>
										</Table.Cell>
										<Table.Cell>
											<span className="font-medium">{letter.reason}</span>
											{letter.detail && (
												<span className="block text-sm text-kumo-subtle">{letter.detail}</span>
											)}
										</Table.Cell>
										<Table.Cell>
											<Badge variant={STATUS_VARIANT[letter.status]} appearance="dot">
												{STATUS_LABEL[letter.status]}
											</Badge>
										</Table.Cell>
										<Table.Cell>{new Date(letter.receivedAt).toLocaleString()}</Table.Cell>
										<Table.Cell>
											{isAdmin && letter.status === "new" ? (
												<DeadLetterActions deadLetterId={letter.id} />
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

export const deadLetterQueueRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/dead-letters",
	component: DeadLetterQueue,
});
