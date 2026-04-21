import * as React from "react";

import type { RolesSelectRow } from "../users/useRolesConfig.js";
import { useRolesConfig } from "../users/useRolesConfig.js";

/** Self-signup default role must not be Admin (API / product rule). */
const MAX_SELF_SIGNUP_DEFAULT_ROLE = 40;

/**
 * Role labels and selects for Allowed Domains (Subscriber–Editor only for defaults).
 * Built on {@link useRolesConfig}; keeps the filter + `Select` `items` shape in one place.
 */
export function useAllowedDomainsRolesConfig(): {
	getRoleLabel: (level: number) => string;
	signupRoles: readonly RolesSelectRow[];
	signupRoleItems: Record<string, string>;
} {
	const { roleLabels, getRoleLabel, roles } = useRolesConfig();

	const signupRoles = React.useMemo(
		() => roles.filter((r) => r.value <= MAX_SELF_SIGNUP_DEFAULT_ROLE),
		[roles],
	);

	const signupRoleItems = React.useMemo(() => {
		const entries: [string, string][] = signupRoles.map((r) => {
			const label = roleLabels[String(r.value)];
			return [String(r.value), label ?? getRoleLabel(r.value)];
		});
		return Object.fromEntries(entries) as Record<string, string>;
	}, [signupRoles, roleLabels, getRoleLabel]);

	return { getRoleLabel, signupRoles, signupRoleItems };
}
