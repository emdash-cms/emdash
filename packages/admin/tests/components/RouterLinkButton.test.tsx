import { Button } from "@cloudflare/kumo";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { describe, expect, it } from "vitest";

import "../../dist/styles.css";
import { RouterLinkButton } from "../../src/components/RouterLinkButton.js";
import { render } from "../utils/render.js";

async function renderInRouter(ui: React.ReactNode) {
	const rootRoute = createRootRoute({ component: Outlet });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <>{ui}</>,
	});
	const newEntryRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/content/$collection/new",
		component: () => <h1>New entry</h1>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute, newEntryRoute]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();
	return render(<RouterProvider router={router} />);
}

describe("RouterLinkButton", () => {
	it.each(["primary", "destructive"] as const)(
		"paints a %s link with the same background as the matching button",
		async (variant) => {
			const screen = await renderInRouter(
				<>
					<Button variant={variant}>Button</Button>
					<RouterLinkButton
						to="/content/$collection/new"
						params={{ collection: "posts" }}
						variant={variant}
					>
						Link
					</RouterLinkButton>
				</>,
			);

			await expect.element(screen.getByRole("link", { name: "Link" })).toBeInTheDocument();
			const button = screen.getByRole("button", { name: "Button" }).element();
			const link = screen.getByRole("link", { name: "Link" }).element();
			const linkBackground = getComputedStyle(link).backgroundColor;

			expect(linkBackground).not.toBe("rgba(0, 0, 0, 0)");
			expect(linkBackground).toBe(getComputedStyle(button).backgroundColor);
		},
	);

	it("links to the route with its params and search, and navigates client-side", async () => {
		const screen = await renderInRouter(
			<RouterLinkButton
				to="/content/$collection/new"
				params={{ collection: "posts" }}
				search={{ locale: "fr" }}
				variant="primary"
			>
				Add New
			</RouterLinkButton>,
		);

		const link = screen.getByRole("link", { name: "Add New" });
		await expect.element(link).toHaveAttribute("href", "/content/posts/new?locale=fr");
		await link.click();
		await expect.element(screen.getByRole("heading", { name: "New entry" })).toBeInTheDocument();
	});
});
