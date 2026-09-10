/**
 * Admin-only route guard.
 *
 * The sidebar and command palette already hide admin entries via
 * `minRole: ROLE_ADMIN`, but a manually-typed URL still mounts the route
 * component — so the in-component check is the source of truth. This
 * mirrors the gate inside `routes/byline-schema.tsx`: show a loader while
 * the current user is being fetched, then either render the children or
 * an access-denied surface instead of silently fetching and 403ing.
 */

import { Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useCurrentUser } from "../lib/api/current-user.js";

// Mirror of `packages/auth/src/rbac.ts:Role.ADMIN`. Inline here for the
// same reason the existing routes inline `ROLE_EDITOR` / `ROLE_ADMIN`:
// avoids a circular dep through `@emdash-cms/auth` for the admin SPA.
const ROLE_ADMIN = 50;

export function RequireAdmin({ children }: { children: React.ReactNode }) {
	const { t } = useLingui();
	const { data: currentUser, isLoading: userLoading } = useCurrentUser();

	if (userLoading) {
		return (
			<div className="flex items-center justify-center min-h-[50vh]">
				<Loader />
			</div>
		);
	}

	if (!currentUser || currentUser.role < ROLE_ADMIN) {
		return (
			<div className="flex items-center justify-center min-h-[50vh]">
				<div className="text-center">
					<h1 className="text-2xl font-semibold leading-tight">{t`Access denied`}</h1>
					<p className="mt-2 text-sm text-kumo-subtle">{t`You need admin permissions to view this page.`}</p>
				</div>
			</div>
		);
	}

	return <>{children}</>;
}
