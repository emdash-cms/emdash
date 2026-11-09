import { i18n } from "@lingui/core";
import {
	Outlet,
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Shell, type ShellProps } from "../src/components/Shell";
import { AdminBrandingProvider } from "../src/lib/admin-branding-context";
import { render } from "./utils/render.tsx";

vi.mock("../src/lib/api/current-user", () => ({
	useCurrentUser: () => ({ data: null }),
}));

vi.mock("../src/components/Header", () => ({ Header: () => <header /> }));
vi.mock("../src/components/AdminCommandPalette", () => ({ AdminCommandPalette: () => null }));
vi.mock("../src/components/WelcomeModal", () => ({ WelcomeModal: () => null }));
vi.mock("../src/components/Sidebar", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/components/Sidebar")>();
	return {
		...actual,
		Sidebar: {
			Provider: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
		},
		SidebarNav: () => <nav />,
	};
});

const manifest: ShellProps["manifest"] = {
	collections: {},
	plugins: {
		orders: {
			adminPages: [
				{ path: "orders", label: "Orders" },
				{ path: "/", label: "Plugin home" },
			],
		},
		"my-shop": { adminPages: [{ path: "orders" }] },
	},
	taxonomies: [],
	i18n: { defaultLocale: "en", locales: ["en", "fr"] },
	siteTitle: "My Site",
};

function makeRouter(initialEntry: string, manifestOverride: ShellProps["manifest"] = manifest) {
	const rootRoute = createRootRoute({
		component: () => (
			<Shell manifest={manifestOverride}>
				<Outlet />
			</Shell>
		),
	});
	const dashboardRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <div>Dashboard</div>,
	});
	const pluginRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/plugins/$pluginId/$",
		staticData: { pageTitle: { id: "Plugin", message: "Plugin" } },
		component: () => <div>Plugin</div>,
	});
	const pluginSettingsRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/plugins-manager/$pluginId/settings",
		staticData: { pageTitle: { id: "Plugin Settings", message: "Plugin Settings" } },
		component: () => <div>Plugin settings</div>,
	});
	const taxonomyRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/taxonomies/$taxonomy",
		staticData: { pageTitle: { id: "Taxonomy", message: "Taxonomy" } },
		component: () => <div>Taxonomy</div>,
	});
	return createRouter({
		routeTree: rootRoute.addChildren([
			dashboardRoute,
			pluginRoute,
			pluginSettingsRoute,
			taxonomyRoute,
		]),
		history: createMemoryHistory({ initialEntries: [initialEntry] }),
	});
}

async function renderShell(router: ReturnType<typeof makeRouter>, adminBranding = {}) {
	return render(
		<AdminBrandingProvider adminBranding={adminBranding}>
			<RouterProvider router={router} />
		</AdminBrandingProvider>,
	);
}

afterEach(() => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

describe("Shell document titles", () => {
	it("uses translated declared labels for slashless plugin paths", async () => {
		i18n.loadAndActivate({ locale: "de", messages: { Orders: "Bestellungen" } });
		await renderShell(makeRouter("/plugins/orders/orders"));

		await vi.waitFor(() => expect(document.title).toBe("Bestellungen · My Site"));
	});

	it("prettifies a plugin id when its page has no declared label", async () => {
		await renderShell(makeRouter("/plugins/my-shop/orders"));

		await vi.waitFor(() => expect(document.title).toBe("My Shop · My Site"));
	});

	it("does not replace the plugin settings title with a plugin page label", async () => {
		await renderShell(makeRouter("/plugins-manager/orders/settings"));

		await vi.waitFor(() => expect(document.title).toBe("Plugin Settings · My Site"));
	});

	it("selects taxonomy titles by requested locale and falls back to the default", async () => {
		const taxonomyManifest = {
			...manifest,
			taxonomies: [
				{ name: "topics", label: "Topics", locale: "en", translationGroup: "topics" },
				{ name: "topics", label: "Sujets", locale: "fr", translationGroup: "topics" },
			],
		};
		const router = makeRouter("/taxonomies/topics?locale=fr", taxonomyManifest);
		await renderShell(router);
		await vi.waitFor(() => expect(document.title).toBe("Sujets · My Site"));

		await router.navigate({
			to: "/taxonomies/$taxonomy",
			params: { taxonomy: "topics" },
			search: { locale: "en" },
		});
		await vi.waitFor(() => expect(document.title).toBe("Topics · My Site"));
		await router.navigate({
			to: "/taxonomies/$taxonomy",
			params: { taxonomy: "topics" },
			search: { locale: "es" },
		});
		await vi.waitFor(() => expect(document.title).toBe("Topics · My Site"));
	});

	it("uses admin branding only when the manifest site title is blank", async () => {
		const blankSiteManifest = { ...manifest, siteTitle: "" };
		await renderShell(makeRouter("/", blankSiteManifest), { siteName: "Admin Brand" });

		await vi.waitFor(() => expect(document.title).toBe("Dashboard · Admin Brand"));
		expect(document.title).not.toContain("EmDash");
	});

	it("prefers Site Title to configured admin branding", async () => {
		await renderShell(makeRouter("/"), { siteName: "Other Brand" });
		await vi.waitFor(() => expect(document.title).toBe("Dashboard · My Site"));
	});
});
