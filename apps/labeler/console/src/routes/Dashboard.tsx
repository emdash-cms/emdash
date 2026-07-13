import { Badge, Grid, LayerCard, Loader } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import * as React from "react";

import { apiClient } from "../api/client.js";
import { AutomationControl } from "../components/AutomationControl.js";
import { QueryError } from "../components/QueryError.js";
import { shellRoute } from "./root.js";

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<LayerCard className="flex flex-col gap-1 p-4">
			<span className="text-sm text-kumo-subtle">{label}</span>
			<span className="text-2xl font-semibold">{value}</span>
		</LayerCard>
	);
}

function Dashboard() {
	const {
		data: status,
		isLoading,
		isError,
		error,
	} = useQuery({
		queryKey: ["system-status"],
		queryFn: () => apiClient.getSystemStatus(),
	});
	const { data: whoami } = useQuery({ queryKey: ["whoami"], queryFn: () => apiClient.whoami() });
	const isAdmin = whoami?.roles.includes("admin") ?? false;

	if (isError) {
		return (
			<div className="flex flex-col gap-6">
				<h1 className="text-xl font-semibold">Dashboard</h1>
				<QueryError title="Failed to load system status" error={error} />
			</div>
		);
	}

	if (isLoading || !status) {
		return (
			<div className="flex items-center justify-center py-16">
				<Loader />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<h1 className="text-xl font-semibold">Dashboard</h1>
			<Grid variant="3up" gap="base">
				<StatCard
					label="Jetstream connection"
					value={
						<Badge variant={status.jetstreamConnected ? "success" : "error"} appearance="dot">
							{status.jetstreamConnected ? "Connected" : "Disconnected"}
						</Badge>
					}
				/>
				<StatCard label="Pending assessments" value={status.pendingAssessments} />
				<StatCard label="Dead-letter depth" value={status.deadLetterDepth} />
			</Grid>
			<AutomationControl
				paused={status.automationPaused}
				pausedReason={status.pausedReason}
				isAdmin={isAdmin}
			/>
			<LayerCard className="p-4 text-sm text-kumo-subtle">
				Labeler DID: <span className="font-mono">{status.labelerDid}</span>
			</LayerCard>
		</div>
	);
}

export const dashboardRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/",
	component: Dashboard,
});
