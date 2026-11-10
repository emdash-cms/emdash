import { LinkProvider, Toasty, type LinkComponentProps } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "customize-sidebars-settings",
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
		archive: {
			label: "Archive",
			labelSingular: "Archived entry",
			supports: ["revisions"],
			hasSeo: false,
			fields: {},
			hidden: true,
		},
	},
	plugins: {
		insights: {
			name: "Insights plugin",
			enabled: true,
			adminMode: "blocks",
			editorPanels: [{ id: "summary", title: "Reading time", route: "summary" }],
		},
	},
	taxonomies: [],
};

const AUTHOR = { id: "ada", email: "ada@example.com", name: "Ada", role: 30 };

const TestLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
	({ href, to, children, ...props }, ref) => (
		<a ref={ref} href={href ?? to} {...props}>
			{children}
		</a>
	),
);
TestLink.displayName = "TestLink";

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestUrl(input: string | URL | Request) {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function layout(nav: { order?: string[]; hidden?: string[] }) {
	return {
		version: 1,
		nav: { order: nav.order ?? [], hidden: nav.hidden ?? [] },
		editor: { order: [], hidden: [] },
	};
}

interface PostedBody {
	action: string;
	adminLayout: unknown;
}

/**
 * `/auth/me` storing one layout. GETs answer with the stored layout, fail
 * while `failGets` is set, or wait while `holdGets` is set; POSTs wait until
 * the test accepts or fails them.
 */
function fakeServer(stored: unknown) {
	const server = {
		stored,
		holdGets: false,
		failGets: false,
		heldGets: [] as (() => void)[],
		posts: [] as {
			body: PostedBody;
			accept: () => void;
			fail: (status: number, message: string) => void;
		}[],
	};

	globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
		const url = requestUrl(input);
		if (url === "/_emdash/api/manifest") return Promise.resolve(json(200, { data: manifest }));
		if (url !== "/_emdash/api/auth/me") throw new Error(`Unexpected request: ${url}`);

		let resolve!: (response: Response) => void;
		const promise = new Promise<Response>((resolvePromise) => {
			resolve = resolvePromise;
		});
		if (init?.method === "POST") {
			if (typeof init.body !== "string") throw new Error("Expected a JSON body");
			const body = JSON.parse(init.body) as PostedBody;
			server.posts.push({
				body,
				accept: () => {
					server.stored = body.adminLayout;
					resolve(json(200, { data: { adminLayout: body.adminLayout } }));
				},
				fail: (status, message) =>
					resolve(json(status, { error: { code: "ADMIN_LAYOUT_SAVE_ERROR", message } })),
			});
			return promise;
		}
		if (server.failGets) {
			return Promise.resolve(
				json(500, { error: { code: "INTERNAL", message: "Database is down" } }),
			);
		}
		const user = { data: { ...AUTHOR, adminLayout: server.stored } };
		if (!server.holdGets) return Promise.resolve(json(200, user));
		server.heldGets.push(() => resolve(json(200, user)));
		return promise;
	}) as typeof fetch;

	return server;
}

async function renderAdmin(
	to: "/settings" | "/settings/sidebars",
	search: { tab?: "editor" } = {},
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 60_000 } },
	});
	const router = createAdminRouter(queryClient);
	await router.navigate({ to, search });

	const screen = await render(
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
	return { screen, router };
}

/** Open the page and wait until its reload of the user has enabled the controls. */
async function openSidebars(search: { tab?: "editor" } = {}) {
	const admin = await renderAdmin("/settings/sidebars", search);
	const control = search.tab === "editor" ? "Show URL & language" : "Show Calendar";
	await expect.element(admin.screen.getByRole("switch", { name: control })).toBeEnabled();
	return admin;
}

function navLinks() {
	const nav = document.querySelector<HTMLElement>(".emdash-sidebar");
	if (!nav) throw new Error("Admin navigation not rendered");
	return Array.from(nav.querySelectorAll('a[data-sidebar^="menu"]'), (link) =>
		link.textContent?.trim(),
	);
}

function rowLabels(listName: string) {
	const list = document.querySelector(`ul[aria-label="${listName}"]`);
	if (!list) throw new Error(`No list named ${listName}`);
	return Array.from(list.querySelectorAll(":scope > li > :first-child"), (row) =>
		row.textContent?.trim(),
	);
}

/** Let a save the queue would start next reach the fake server. */
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

function nextFrame() {
	return new Promise((resolve) => requestAnimationFrame(resolve));
}

describe("Settings → Sidebars", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		localStorage.clear();
		localStorage.setItem("emdash-sidebar-folders", JSON.stringify({ Blog: true }));
		i18n.loadAndActivate({ locale: "en", messages: {} });
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("opens for an author from Settings and enables its controls once the user reloads", async () => {
		const server = fakeServer(layout({ hidden: ["/calendar"] }));
		const { screen } = await renderAdmin("/settings");
		const personal = screen.getByRole("region", { name: "Personal" });
		await expect.element(personal).toBeInTheDocument();

		server.holdGets = true;
		await personal.getByRole("link", { name: /^Sidebars/ }).click();

		await expect.element(screen.getByRole("heading", { name: "Sidebars", level: 1 })).toBeVisible();
		await vi.waitFor(() => expect(server.heldGets).toHaveLength(1));
		const showMedia = screen.getByRole("switch", { name: "Show Media" });
		await expect.element(showMedia).toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Reorder Blog" })).toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Reset navigation" })).toBeDisabled();

		server.heldGets[0]?.();
		await expect.element(showMedia).toBeEnabled();
		await expect.element(screen.getByRole("button", { name: "Reorder Blog" })).toBeEnabled();
		await expect.element(screen.getByRole("button", { name: "Reset navigation" })).toBeEnabled();
		await expect.element(screen.getByRole("switch", { name: "Show Calendar" })).not.toBeChecked();
	});

	it("shows why the page can't be used when its reload of the user fails, and retries", async () => {
		const server = fakeServer(null);
		const { screen } = await renderAdmin("/settings");
		const personal = screen.getByRole("region", { name: "Personal" });
		await expect.element(personal).toBeInTheDocument();

		server.failGets = true;
		await personal.getByRole("link", { name: /^Sidebars/ }).click();

		await expect.element(screen.getByText("Couldn't load your sidebars")).toBeVisible();
		await expect.element(screen.getByText("Database is down")).toBeVisible();
		await expect.element(screen.getByRole("switch", { name: "Show Media" })).toBeDisabled();

		server.failGets = false;
		await screen.getByRole("button", { name: "Retry" }).click();

		await expect.element(screen.getByRole("switch", { name: "Show Media" })).toBeEnabled();
		await expect.element(screen.getByText("Couldn't load your sidebars")).not.toBeInTheDocument();
	});

	it("hides an entry from the navigation at once and saves the layout", async () => {
		const server = fakeServer(null);
		const { screen } = await openSidebars();
		expect(navLinks()).toContain("Media");

		await screen.getByRole("switch", { name: "Show Media" }).click();

		await vi.waitFor(() => expect(navLinks()).not.toContain("Media"));
		expect(navLinks()).toContain("Posts");
		await expect.element(screen.getByRole("switch", { name: "Show Media" })).not.toBeChecked();
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		expect(server.posts[0]?.body).toEqual({
			action: "setAdminLayout",
			adminLayout: layout({ hidden: ["/media"] }),
		});
	});

	it("moves a row with Alt+ArrowDown, keeps focus on its handle, and announces it", async () => {
		const server = fakeServer(null);
		const { screen } = await openSidebars();
		const links = navLinks();
		expect(links.indexOf("Posts")).toBeLessThan(links.indexOf("Media"));

		const handle = screen.getByRole("button", { name: "Reorder Blog" });
		(handle.element() as HTMLElement).focus();
		await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");

		await vi.waitFor(() => {
			const moved = navLinks();
			expect(moved.indexOf("Media")).toBeLessThan(moved.indexOf("Posts"));
		});
		expect(rowLabels("Content")).toEqual(["Media", "Blog"]);
		expect(rowLabels("Blog")).toEqual(["Posts", "Pages"]);
		await nextFrame();
		await nextFrame();
		expect(document.activeElement).toBe(handle.element());
		await expect
			.element(screen.getByText("Blog moved to position 2 of 2.", { exact: true }))
			.toBeInTheDocument();
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		expect(server.posts[0]?.body.adminLayout).toEqual(
			layout({ order: ["/calendar", "/media", "folder:Blog", "/content/posts", "/content/pages"] }),
		);
	});

	it("counts the pinned Dashboard in the positions it announces", async () => {
		fakeServer(null);
		const { screen } = await openSidebars();

		const handle = screen.getByRole("button", { name: "Reorder Calendar" });
		(handle.element() as HTMLElement).focus();
		await userEvent.keyboard(" ");
		await expect
			.element(screen.getByText("Picked up Calendar, position 2 of 2.", { exact: true }))
			.toBeInTheDocument();
		expect(document.body.textContent).not.toContain("Calendar moved to position");

		await userEvent.keyboard("{Escape}");
		await expect
			.element(screen.getByText("Cancelled. Calendar is back at position 2 of 2.", { exact: true }))
			.toBeInTheDocument();
	});

	it("sends only the latest layout after the save in flight", async () => {
		const server = fakeServer(null);
		const { screen } = await openSidebars();

		await screen.getByRole("switch", { name: "Show Media" }).click();
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		await screen.getByRole("switch", { name: "Show Calendar" }).click();
		await screen.getByRole("switch", { name: "Show Pages" }).click();
		await settle();
		expect(server.posts).toHaveLength(1);

		server.posts[0]?.accept();
		await vi.waitFor(() => expect(server.posts).toHaveLength(2));
		expect(server.posts[1]?.body.adminLayout).toEqual(
			layout({ hidden: ["/media", "/calendar", "/content/pages"] }),
		);
		server.posts[1]?.accept();
		await settle();
		expect(server.posts).toHaveLength(2);
	});

	it("restores the last accepted layout and shows the server's message when a save fails", async () => {
		const server = fakeServer(layout({ hidden: ["/content/pages"] }));
		const { screen } = await openSidebars();
		expect(navLinks()).not.toContain("Pages");

		await screen.getByRole("switch", { name: "Show Media" }).click();
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		await screen.getByRole("switch", { name: "Show Calendar" }).click();
		await vi.waitFor(() => expect(navLinks()).not.toContain("Calendar"));

		server.posts[0]?.fail(400, "The layout is too large");

		await expect.element(screen.getByText("The layout is too large")).toBeVisible();
		await expect.element(screen.getByRole("switch", { name: "Show Media" })).toBeChecked();
		await expect.element(screen.getByRole("switch", { name: "Show Calendar" })).toBeChecked();
		await expect.element(screen.getByRole("switch", { name: "Show Pages" })).not.toBeChecked();
		expect(navLinks()).toEqual(expect.arrayContaining(["Media", "Calendar"]));
		expect(navLinks()).not.toContain("Pages");
		await settle();
		expect(server.posts).toHaveLength(1);
	});

	it("resets the navigation and brings the previous layout back with Undo", async () => {
		const server = fakeServer(layout({ hidden: ["/media"] }));
		const { screen } = await openSidebars();
		expect(navLinks()).not.toContain("Media");

		await screen.getByRole("button", { name: "Reset navigation" }).click();

		await vi.waitFor(() => expect(navLinks()).toContain("Media"));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		expect(server.posts[0]?.body).toEqual({ action: "setAdminLayout", adminLayout: null });
		server.posts[0]?.accept();
		await expect.element(screen.getByRole("button", { name: "Reset navigation" })).toBeDisabled();
		await expect.element(screen.getByText("Navigation reset")).toBeVisible();
		await expect
			.element(screen.getByText("Everything is shown again, in the default order."))
			.toBeVisible();

		await screen.getByRole("button", { name: "Undo" }).click();

		await vi.waitFor(() => expect(navLinks()).not.toContain("Media"));
		await vi.waitFor(() => expect(server.posts).toHaveLength(2));
		expect(server.posts[1]?.body.adminLayout).toEqual(layout({ hidden: ["/media"] }));
		await expect.element(screen.getByText("Navigation reset")).not.toBeInTheDocument();
	});

	it("moves focus to the selected tab when Reset disables itself", async () => {
		fakeServer(layout({ hidden: ["/media"] }));
		const { screen } = await openSidebars();

		const reset = screen.getByRole("button", { name: "Reset navigation" });
		(reset.element() as HTMLElement).focus();
		await userEvent.keyboard("{Enter}");

		await expect.element(reset).toBeDisabled();
		await nextFrame();
		await nextFrame();
		expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Navigation" }).element());
	});

	it("opens the Editor sidebar tab from ?tab=editor and keeps the tab in the URL", async () => {
		fakeServer(null);
		const { screen, router } = await openSidebars({ tab: "editor" });

		await expect
			.element(screen.getByRole("tab", { name: "Editor sidebar" }))
			.toHaveAttribute("aria-selected", "true");
		await expect
			.element(screen.getByRole("list", { name: "Editor sidebar sections" }))
			.toBeInTheDocument();

		await screen.getByRole("tab", { name: "Navigation" }).click();
		await expect.element(screen.getByRole("list", { name: "Content" })).toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/settings/sidebars");
		expect(router.state.location.search).toEqual({});

		await screen.getByRole("tab", { name: "Editor sidebar" }).click();
		await expect
			.element(screen.getByRole("list", { name: "Editor sidebar sections" }))
			.toBeInTheDocument();
		expect(router.state.location.search).toEqual({ tab: "editor" });
	});

	it("lists every editor section the user can meet and keeps the always-shown rows on", async () => {
		fakeServer(null);
		const { screen } = await openSidebars({ tab: "editor" });

		expect(rowLabels("Editor sidebar sections")).toEqual([
			"Publish",
			"URL & language",
			"Reading timeInsights plugin",
			"Revisions",
		]);
		await expect.element(screen.getByText("Insights plugin")).toBeVisible();
		await expect
			.element(screen.getByRole("switch", { name: "Publish is always shown" }))
			.toBeDisabled();
		await expect.element(screen.getByRole("switch", { name: "Show Revisions" })).toBeEnabled();

		await screen.getByRole("tab", { name: "Navigation" }).click();
		await expect
			.element(screen.getByRole("switch", { name: "Dashboard is always shown" }))
			.toBeDisabled();
		expect(screen.getByRole("button", { name: "Reorder Dashboard" }).query()).toBeNull();
	});
});
