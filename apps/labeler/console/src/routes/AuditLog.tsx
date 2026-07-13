import { Empty } from "@cloudflare/kumo";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import { createRoute } from "@tanstack/react-router";

import { shellRoute } from "./root.js";

/**
 * The `operator_actions` audit table (plan W9.2) hasn't landed yet, so this
 * route is a fixed empty state rather than a fixture-backed list — there's
 * no real schema to mirror data from until that PR merges.
 */
function AuditLog() {
	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-xl font-semibold">Audit log</h1>
			<Empty
				icon={<ClockCounterClockwise size={48} />}
				title="Audit log not yet available"
				description="Operator action history ships once the audit table lands."
			/>
		</div>
	);
}

export const auditLogRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/audit",
	component: AuditLog,
});
