import { Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useCurrentUser } from "../lib/api/current-user.js";

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
