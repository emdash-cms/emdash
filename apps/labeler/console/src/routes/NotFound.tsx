import { createRoute } from "@tanstack/react-router";

import { shellRoute } from "./root.js";

function NotFoundPage() {
	return (
		<div className="flex min-h-[50vh] items-center justify-center">
			<div className="text-center">
				<h1 className="text-2xl font-bold">Not found</h1>
				<p className="mt-2 text-kumo-subtle">This page doesn't exist.</p>
			</div>
		</div>
	);
}

export const notFoundRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "*",
	component: NotFoundPage,
});
