import { Badge, LayerCard, Loader, Select, Table } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link, useNavigate } from "@tanstack/react-router";

import { apiClient } from "../api/client.js";
import type { PublicAssessmentState } from "../api/types.js";
import { StateBadge } from "../components/StateBadge.js";
import { shellRoute } from "./root.js";

const PUBLIC_STATES: readonly PublicAssessmentState[] = [
	"pending",
	"passed",
	"warned",
	"blocked",
	"error",
	"superseded",
];

function isPublicAssessmentState(value: string): value is PublicAssessmentState {
	return (PUBLIC_STATES as readonly string[]).includes(value);
}

export interface AssessmentListSearch {
	state?: PublicAssessmentState;
}

const STATE_LABELS: Record<PublicAssessmentState, string> = {
	pending: "Pending",
	passed: "Passed",
	warned: "Warned",
	blocked: "Blocked",
	error: "Error",
	superseded: "Superseded",
};

function AssessmentList() {
	const navigate = useNavigate();
	const { state } = assessmentListRoute.useSearch();

	const { data, isLoading } = useQuery({
		queryKey: ["assessments", { state }],
		queryFn: () => apiClient.listAssessments({ state }),
	});

	const handleStateChange = (value: string | null) => {
		void navigate({
			to: "/assessments",
			search: value && isPublicAssessmentState(value) ? { state: value } : {},
		});
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold">Assessments</h1>
				<Select
					aria-label="Filter by state"
					value={state ?? "all"}
					onValueChange={handleStateChange}
				>
					<Select.Option value="all">All states</Select.Option>
					{PUBLIC_STATES.map((value) => (
						<Select.Option key={value} value={value}>
							{STATE_LABELS[value]}
						</Select.Option>
					))}
				</Select>
			</div>

			<LayerCard className="p-0">
				{isLoading || !data ? (
					<div className="flex items-center justify-center py-16">
						<Loader />
					</div>
				) : data.items.length === 0 ? (
					<div className="p-8 text-center text-sm text-kumo-subtle">No assessments found.</div>
				) : (
					<Table>
						<Table.Header>
							<Table.Row>
								<Table.Head>Subject</Table.Head>
								<Table.Head>State</Table.Head>
								<Table.Head>Trigger</Table.Head>
								<Table.Head>Created</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{data.items.map((assessment) => (
								<Table.Row key={assessment.id}>
									<Table.Cell>
										<Link
											to="/assessments/$id"
											params={{ id: assessment.id }}
											className="font-medium text-kumo-link hover:underline"
										>
											{assessment.uri.split("/").pop()}
										</Link>
										{assessment.isSuperseded && (
											<Badge variant="neutral" className="ms-2">
												Superseded
											</Badge>
										)}
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

			{data?.nextCursor && (
				<div className="flex justify-center">
					<span className="text-sm text-kumo-subtle">More assessments available.</span>
				</div>
			)}
		</div>
	);
}

export const assessmentListRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/assessments",
	component: AssessmentList,
	validateSearch: (search: Record<string, unknown>): AssessmentListSearch => ({
		state:
			typeof search.state === "string" && isPublicAssessmentState(search.state)
				? search.state
				: undefined,
	}),
});
