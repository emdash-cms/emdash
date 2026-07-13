import type { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { assessmentDetailRoute } from "./routes/AssessmentDetail.js";
import { assessmentListRoute } from "./routes/AssessmentList.js";
import { auditLogRoute } from "./routes/AuditLog.js";
import { dashboardRoute } from "./routes/Dashboard.js";
import { notFoundRoute } from "./routes/NotFound.js";
import { rootRoute, shellRoute } from "./routes/root.js";
import { subjectHistoryRoute } from "./routes/SubjectHistory.js";

const shellRoutes = shellRoute.addChildren([
	dashboardRoute,
	assessmentListRoute,
	assessmentDetailRoute,
	subjectHistoryRoute,
	auditLogRoute,
	notFoundRoute,
]);

const routeTree = rootRoute.addChildren([shellRoutes]);

export function createConsoleRouter(queryClient: QueryClient) {
	return createRouter({
		routeTree,
		context: { queryClient },
		// Served as Workers static assets under /admin (plan W9.3).
		basepath: "/admin",
		defaultPreload: "intent",
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createConsoleRouter>;
	}
}
