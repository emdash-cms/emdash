import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, Outlet } from "@tanstack/react-router";

import { Shell } from "../components/Shell.js";

export interface RouterContext {
	queryClient: QueryClient;
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
	component: () => <Outlet />,
});

/** Pathless layout route: every console page renders inside the Shell. */
export const shellRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: "_shell",
	component: () => (
		<Shell>
			<Outlet />
		</Shell>
	),
});
