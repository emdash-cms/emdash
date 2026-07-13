import { Badge, Grid, LayerCard, Loader } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import * as React from "react";

import { apiClient } from "../api/client.js";
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
	const { data: status, isLoading } = useQuery({
		queryKey: ["system-status"],
		queryFn: () => apiClient.getSystemStatus(),
	});

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
			<Grid variant="4up" gap="base">
				<StatCard
					label="Jetstream connection"
					value={
						<Badge variant={status.jetstreamConnected ? "success" : "error"} appearance="dot">
							{status.jetstreamConnected ? "Connected" : "Disconnected"}
						</Badge>
					}
				/>
				<StatCard label="Pending assessments" value={status.pendingAssessments} />
				<StatCard label="Discovery queue depth" value={status.discoveryQueueDepth} />
				<StatCard
					label="Last reconciliation"
					value={
						status.lastReconciliationAt
							? new Date(status.lastReconciliationAt).toLocaleString()
							: "Never"
					}
				/>
			</Grid>
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
