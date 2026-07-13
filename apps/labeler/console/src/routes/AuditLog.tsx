import { Empty, Loader } from "@cloudflare/kumo";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";

import { apiClient } from "../api/client.js";
import { QueryError } from "../components/QueryError.js";
import { shellRoute } from "./root.js";

/**
 * The `operator_actions` audit table (plan W9.2) hasn't landed yet, so the
 * fixture client always resolves an empty list here — the loading/error
 * states below exist for when a real `/admin/api/audit-log` backs this.
 */
function AuditLog() {
	const { isLoading, isError, error } = useQuery({
		queryKey: ["audit-log"],
		queryFn: () => apiClient.listAuditLog(),
	});

	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-xl font-semibold">Audit log</h1>
			{isError ? (
				<QueryError title="Failed to load audit log" error={error} />
			) : isLoading ? (
				<div className="flex items-center justify-center py-16">
					<Loader />
				</div>
			) : (
				<Empty
					icon={<ClockCounterClockwise size={48} />}
					title="Audit log not yet available"
					description="Operator action history ships once the audit table lands."
				/>
			)}
		</div>
	);
}

export const auditLogRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/audit",
	component: AuditLog,
});
