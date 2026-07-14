import { DirectionProvider } from "@cloudflare/kumo/primitives";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import type { WhoamiIdentity } from "../api/types.js";
import { assessmentDetailRoute } from "../routes/AssessmentDetail.js";
import { assessmentListRoute } from "../routes/AssessmentList.js";
import { auditLogRoute } from "../routes/AuditLog.js";
import { dashboardRoute } from "../routes/Dashboard.js";
import { deadLetterQueueRoute } from "../routes/DeadLetterQueue.js";
import { notFoundRoute } from "../routes/NotFound.js";
import { rootRoute, shellRoute } from "../routes/root.js";
import { subjectHistoryRoute } from "../routes/SubjectHistory.js";

const routeTree = rootRoute.addChildren([
	shellRoute.addChildren([
		dashboardRoute,
		assessmentListRoute,
		assessmentDetailRoute,
		subjectHistoryRoute,
		auditLogRoute,
		deadLetterQueueRoute,
		notFoundRoute,
	]),
]);

export const ADMIN_IDENTITY: WhoamiIdentity = {
	kind: "human",
	principal: "admin@example.com",
	sub: "dev-admin",
	roles: ["admin"],
};

export const REVIEWER_IDENTITY: WhoamiIdentity = {
	kind: "human",
	principal: "reviewer@example.com",
	sub: "dev-reviewer",
	roles: ["reviewer"],
};

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

export function renderRoute(path: string): RenderResult {
	const queryClient = newClient();
	const router = createRouter({
		routeTree,
		context: { queryClient },
		basepath: "/admin",
		history: createMemoryHistory({ initialEntries: [`/admin${path}`] }),
	});
	return render(
		<DirectionProvider direction="ltr">
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</DirectionProvider>,
	);
}

export function renderWithClient(ui: ReactElement): RenderResult {
	return render(
		<DirectionProvider direction="ltr">
			<QueryClientProvider client={newClient()}>{ui}</QueryClientProvider>
		</DirectionProvider>,
	);
}
