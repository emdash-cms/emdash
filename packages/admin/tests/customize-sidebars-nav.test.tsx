import { LinkProvider, Toasty, type LinkComponentProps } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "customize-sidebars-nav",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: [],
			hasSeo: false,
			fields: {},
			group: "Blog",
		},
		pages: {
			label: "Pages",
			labelSingular: "Page",
			supports: [],
			hasSeo: false,
			fields: {},
			group: "Blog",
		},
	},
	plugins: {},
	taxonomies: [],
};

const ADMIN_ENTRIES = [
	"/content-types",
	"/byline-schema",
	"/users",
	"/plugins-manager",
	"/import/wordpress",
	"/settings",
];

const TestLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
	({ href, to, children, ...props }, ref) => (
		<a ref={ref} href={href ?? to} {...props}>
			{children}
		</a>
	),
);
TestLink.displayName = "TestLink";

function json(data: unknown) {
	return Promise.resolve(
		new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }),
	);
}

function requestUrl(input: string | URL | Request) {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

let adminLayout: unknown;
let holdAuthMe: Promise<void> | null;

function layout(nav: { order?: string[]; hidden?: string[] }) {
	return {
		version: 1,
		nav: { order: nav.order ?? [], hidden: nav.hidden ?? [] },
		editor: { order: [], hidden: [] },
	};
}

async function mountAdmin() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 60_000 } },
	});
	const router = createAdminRouter(queryClient);
	await router.navigate({ to: "/" });

	return render(
		<ThemeProvider defaultTheme="light">
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<LinkProvider component={TestLink}>
							<RouterProvider router={router} />
						</LinkProvider>
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>
		</ThemeProvider>,
	);
}

async function renderAdmin() {
	const screen = await mountAdmin();
	await expect.element(screen.getByRole("link", { name: "Menus" })).toBeInTheDocument();
	await expect.element(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
	return screen;
}

function navigation(): HTMLElement {
	const nav = document.querySelector<HTMLElement>(".emdash-sidebar");
	if (!nav) throw new Error("Admin navigation not rendered");
	return nav;
}

function navLinks() {
	return Array.from(navigation().querySelectorAll('a[data-sidebar^="menu"]'), (link) =>
		link.textContent?.trim(),
	);
}

function groupLabels() {
	return Array.from(navigation().querySelectorAll('[data-sidebar="group-label"]'), (label) =>
		label.textContent?.trim(),
	);
}

describe("navigation with a personal sidebar layout", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		adminLayout = undefined;
		holdAuthMe = null;
		localStorage.clear();
		localStorage.setItem("emdash-sidebar-folders", JSON.stringify({ Blog: true }));
		i18n.loadAndActivate({ locale: "en", messages: {} });
		globalThis.fetch = vi.fn((input: string | URL | Request) => {
			const url = requestUrl(input);
			if (url === "/_emdash/api/manifest") return json({ data: manifest });
			if (url === "/_emdash/api/auth/me") {
				const user = {
					data: { id: "ada", email: "ada@example.com", name: "Ada", role: 50, adminLayout },
				};
				return holdAuthMe ? holdAuthMe.then(() => json(user)) : json(user);
			}
			if (url === "/_emdash/api/admin/comments/counts") {
				return json({ data: { pending: 0, approved: 0, spam: 0, trash: 0 } });
			}
			if (url === "/_emdash/api/dashboard") {
				return json({ data: { collections: [], mediaCount: 0, userCount: 0, recentItems: [] } });
			}
			if (url === "/_emdash/api/admin/transfer/capabilities") {
				return json({
					data: { portableDomain: { empty: false, blockers: [], seededScaffold: [] } },
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		}) as typeof fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		await page.viewport(1280, 800);
	});

	it("renders the default navigation without a stored layout", async () => {
		await renderAdmin();
		expect(navLinks().slice(0, 5)).toEqual(["Dashboard", "Calendar", "Posts", "Pages", "Media"]);
		expect(groupLabels()).toEqual(["Content", "Manage", "Admin"]);
	});

	it("leaves a hidden entry out", async () => {
		adminLayout = layout({ hidden: ["/media"] });
		await renderAdmin();
		expect(navLinks()).not.toContain("Media");
		expect(navLinks()).toContain("Posts");
	});

	it("reorders siblings within a group and within a folder", async () => {
		adminLayout = layout({ order: ["/content/pages", "/content/posts", "/bylines", "/comments"] });
		await renderAdmin();
		const links = navLinks();
		expect(links.indexOf("Pages")).toBeLessThan(links.indexOf("Posts"));
		expect(links.indexOf("Bylines")).toBeLessThan(links.indexOf("Comments"));
		expect(links.indexOf("Comments")).toBeLessThan(links.indexOf("Menus"));
	});

	it("drops a folder whose members are all hidden", async () => {
		adminLayout = layout({ hidden: ["/content/posts", "/content/pages"] });
		await renderAdmin();
		expect(navLinks()).toContain("Media");
		expect(navigation().textContent).not.toContain("Blog");
		expect(groupLabels()).toContain("Content");
	});

	it("drops a group's heading when every entry in it is hidden", async () => {
		adminLayout = layout({ hidden: ADMIN_ENTRIES });
		await renderAdmin();
		expect(groupLabels()).toEqual(["Content", "Manage"]);
		expect(navLinks()).not.toContain("Users");
	});

	it("keeps Dashboard first and shown when the layout lists it last and hidden", async () => {
		adminLayout = layout({ order: ["/calendar", "/"], hidden: ["/"] });
		await renderAdmin();
		expect(navLinks().slice(0, 2)).toEqual(["Dashboard", "Calendar"]);
	});

	it("links to Settings → Sidebars from the footer until the nav collapses", async () => {
		const screen = await renderAdmin();
		const nav = screen.getByRole("complementary", { name: "Admin navigation" });
		const customize = nav.getByRole("link", { name: "Customize sidebar" });
		await expect.element(customize).toHaveAttribute("href", "/_emdash/admin/settings/sidebars");

		await nav.getByRole("button", { name: "Collapse sidebar" }).click();
		await expect.element(nav.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
		expect(document.querySelector('a[aria-label="Customize sidebar"]')).toBeNull();
	});

	it("never shows a hidden entry while the user is still loading", async () => {
		adminLayout = layout({ hidden: ["/media"] });
		let releaseAuthMe!: () => void;
		holdAuthMe = new Promise((resolve) => {
			releaseAuthMe = resolve;
		});
		const seen: (string | undefined)[] = [];
		const observer = new MutationObserver(() => {
			for (const link of document.querySelectorAll(".emdash-sidebar a[data-sidebar^='menu']")) {
				seen.push(link.textContent?.trim());
			}
		});
		observer.observe(document.body, { childList: true, subtree: true, characterData: true });

		try {
			const screen = await mountAdmin();
			await vi.waitFor(() =>
				expect(globalThis.fetch).toHaveBeenCalledWith("/_emdash/api/auth/me", expect.anything()),
			);
			await new Promise((resolve) => setTimeout(resolve, 100));

			releaseAuthMe();
			await expect.element(screen.getByRole("link", { name: "Menus" })).toBeInTheDocument();
			await new Promise((resolve) => setTimeout(resolve, 50));
		} finally {
			observer.disconnect();
		}

		expect(seen).toContain("Menus");
		expect(seen).not.toContain("Media");
	});

	it("links to Settings → Sidebars from the phone sheet after the desktop nav collapsed", async () => {
		const screen = await renderAdmin();
		const nav = screen.getByRole("complementary", { name: "Admin navigation" });
		await nav.getByRole("button", { name: "Collapse sidebar" }).click();
		await expect.element(nav.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

		await page.viewport(390, 844);
		await vi.waitFor(() => expect(navigation().dataset.mobile).toBe("true"));
		const headerTrigger = document.querySelector<HTMLElement>('header [data-sidebar="trigger"]');
		if (!headerTrigger) throw new Error("Header sidebar trigger not rendered");
		await expect.element(headerTrigger).toBeVisible();
		headerTrigger.click();
		await expect.element(page.getByRole("link", { name: "Customize sidebar" })).toBeVisible();
	});
});
