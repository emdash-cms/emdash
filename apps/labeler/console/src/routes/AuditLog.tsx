import { Empty } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import { createRoute } from "@tanstack/react-router";

import { shellRoute } from "./root.js";

/**
 * The `operator_actions` audit table (plan W9.2) hasn't landed yet, so this
 * route is a fixed empty state rather than a fixture-backed list — there's
 * no real schema to mirror data from until that PR merges.
 */
function AuditLog() {
	const { t } = useLingui();
	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-xl font-semibold">{t`Audit log`}</h1>
			<Empty
				icon={<ClockCounterClockwise size={48} />}
				title={t`Audit log not yet available`}
				description={t`Operator action history ships once the audit table lands.`}
			/>
		</div>
	);
}

export const auditLogRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/audit",
	component: AuditLog,
});
