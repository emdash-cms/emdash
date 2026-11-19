import {
	Outlet,
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	useMatches,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import {
	AdminBreadcrumbs,
	BreadcrumbProvider,
	useBreadcrumbLabel,
} from "../../src/components/AdminBreadcrumbs";
import { render } from "../utils/render.tsx";

describe("useBreadcrumbLabel", () => {
	it("names the crumb without rendering the page again", async () => {
		let pageRenders = 0;
		function ShopPage() {
			pageRenders++;
			useBreadcrumbLabel("Corner shop");
			return <h1>Shop</h1>;
		}
		function Layout() {
			const pathname = useMatches({ select: (matches) => matches.at(-1)?.pathname ?? "/" });
			return (
				<BreadcrumbProvider pageKey={pathname}>
					<AdminBreadcrumbs />
					<Outlet />
				</BreadcrumbProvider>
			);
		}
		const root = createRootRoute({ component: Layout });
		const shops = createRoute({
			getParentRoute: () => root,
			path: "/shops",
			staticData: { pageTitle: { id: "Shops", message: "Shops" } },
		});
		const shop = createRoute({
			getParentRoute: () => root,
			path: "/shops/$shop",
			staticData: {
				pageTitle: { id: "Edit shop", message: "Edit shop" },
				breadcrumb: { parent: "/shops", dynamic: true },
			},
			component: ShopPage,
		});
		const router = createRouter({
			routeTree: root.addChildren([shops, shop]),
			history: createMemoryHistory({ initialEntries: ["/shops/corner"] }),
		});

		await render(<RouterProvider router={router} />);

		await expect
			.element(page.getByRole("navigation").getByText("Corner shop", { exact: true }).first())
			.toBeInTheDocument();
		expect(pageRenders).toBe(1);
	});
});
