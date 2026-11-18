import "../dist/styles.css";
import { LinkProvider, Toasty } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { type AnyRoute, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { KumoRouterLink } from "../src/App";
import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import { LocaleDirectionProvider } from "../src/locales/index.js";
import { KumoTranslationsProvider } from "../src/locales/KumoTranslationsProvider";
import { loadMessages } from "../src/locales/loadMessages";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers";

const ROLE_EDITOR = 40;
const ROLE_ADMIN = 50;
const ADMIN = "/_emdash/admin";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "admin-breadcrumbs",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts"],
			hasSeo: false,
			fields: { title: { kind: "string", label: "Title" } },
		},
	},
	plugins: {},
	taxonomies: [],
};

const FOLDER = { id: "folder_1", name: "Product photos" };

function menuWithLabel(label: string) {
	return {
		id: "menu_1",
		name: "main",
		label,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		locale: "en",
		translationGroup: null,
		items: [],
	};
}

type Handler = () => Response | Promise<Response>;

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const notFound = () => json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let handlers: Map<string, Handler>;
let role: number;
let manifest: AdminManifest;
let originalFetch: typeof fetch;
const originalUrl = window.location.href;

function on(url: string, handler: Handler) {
	handlers.set(url, handler);
}

async function openAdmin(path: string, locale = "en") {
	const messages = locale === "en" ? {} : await loadMessages(locale);
	i18n.loadAndActivate({
		locale,
		messages: { ...messages, [msg`Breadcrumb`.id]: locale === "en" ? "Breadcrumb" : "مسار التنقل" },
	});
	window.history.replaceState(null, "", `${ADMIN}${path}`);
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	const screen = await render(
		<ThemeProvider defaultTheme="light">
			<I18nProvider i18n={i18n}>
				<LocaleDirectionProvider>
					<KumoTranslationsProvider>
						<Toasty>
							<QueryClientProvider client={queryClient}>
								<LinkProvider component={KumoRouterLink}>
									<RouterProvider router={router} />
								</LinkProvider>
							</QueryClientProvider>
						</Toasty>
					</KumoTranslationsProvider>
				</LocaleDirectionProvider>
			</I18nProvider>
		</ThemeProvider>,
	);
	return { screen, router };
}

function trailNav() {
	return page.getByRole("navigation", { name: i18n._(msg`Breadcrumb`), exact: true });
}

/** The crumbs a sighted user sees, in DOM order. Kumo renders a hidden copy for the other breakpoint. */
function readTrail() {
	const nav = trailNav().query();
	if (!nav) return null;
	return [...nav.querySelectorAll<HTMLElement>("a, [aria-current], .skeleton-line")]
		.filter((element) => element.checkVisibility())
		.map((element) => {
			if (element.matches(".skeleton-line")) return { loading: true };
			const crumb: { label: string; href?: string; current?: string } = {
				label: element.textContent ?? "",
			};
			if (element.tagName === "A") crumb.href = element.getAttribute("href") ?? "";
			const current = element.getAttribute("aria-current");
			if (current) crumb.current = current;
			return crumb;
		});
}

function visibleIn(root: Element, selector: string) {
	return [...root.querySelectorAll<HTMLElement>(selector)].find((element) =>
		element.checkVisibility(),
	);
}

beforeEach(() => {
	handlers = new Map();
	role = ROLE_ADMIN;
	manifest = MANIFEST;
	originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url === "/_emdash/api/manifest") return json({ data: manifest });
		if (url === "/_emdash/api/auth/me") {
			return json({ data: { id: "user_1", email: "ada@example.com", name: "Ada", role } });
		}
		const handler = handlers.get(url) ?? handlers.get(url.split("?")[0]!);
		return handler ? handler() : notFound();
	}) as typeof fetch;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	window.history.replaceState(null, "", originalUrl);
	i18n.loadAndActivate({ locale: "en", messages: {} });
	document.documentElement.setAttribute("dir", "ltr");
	await page.viewport(1280, 800);
});

describe("admin breadcrumbs", () => {
	it("puts a settings page under Settings, which shows no trail of its own", async () => {
		await openAdmin("/settings/general");

		await expect.element(trailNav()).toBeVisible();
		await vi.waitFor(() =>
			expect(readTrail()).toEqual([
				{ label: "Settings", href: `${ADMIN}/settings` },
				{ label: "General", current: "page" },
			]),
		);
		const sidebarSettings = document.querySelector(`.emdash-sidebar a[href="${ADMIN}/settings"]`);
		expect(sidebarSettings).toHaveAttribute("aria-current", "page");

		await trailNav().getByRole("link", { name: "Settings", exact: true }).click();
		await expect.element(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
		expect(window.location.pathname).toBe(`${ADMIN}/settings`);
		await expect.element(trailNav()).not.toBeInTheDocument();
	});

	it("names each settings page after its row on the Settings page", async () => {
		const { router } = await openAdmin("/settings");
		await expect.element(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

		const routes: Record<string, AnyRoute | undefined> = router.routesByPath;
		const crumbLabel = (path: string) => {
			const data = routes[path]?.options.staticData;
			const descriptor: MessageDescriptor | undefined = data?.breadcrumb?.label ?? data?.pageTitle;
			return descriptor ? i18n._(descriptor) : undefined;
		};
		const rows = [
			...document.querySelectorAll<HTMLAnchorElement>(`main a[href^="${ADMIN}/settings/"]`),
		];
		const subpages = Object.keys(routes).filter((path) => path.startsWith("/settings/"));
		expect(rows.map((row) => row.getAttribute("href")!.slice(ADMIN.length)).toSorted()).toEqual(
			subpages.toSorted(),
		);
		for (const row of rows) {
			const path = row.getAttribute("href")!.slice(ADMIN.length);
			expect(crumbLabel(path), path).toBe(row.innerText.split("\n")[0]);
		}
	});

	it("puts Relations under Content Types", async () => {
		on("/_emdash/api/relations", () => json({ data: { items: [] } }));
		on("/_emdash/api/schema/collections", () => json({ data: { items: [] } }));
		await openAdmin("/content-types/relations");

		await expect.element(page.getByRole("heading", { name: "Relations", level: 1 })).toBeVisible();
		expect(readTrail()).toEqual([
			{ label: "Content Types", href: `${ADMIN}/content-types` },
			{ label: "Relations", current: "page" },
		]);
	});

	it("shows a skeleton for a menu's name until the menu loads, without changing length", async () => {
		const menuLoaded = deferred();
		on("/_emdash/api/menus/main", async () => {
			await menuLoaded.promise;
			return json({ data: menuWithLabel("Main navigation") });
		});
		await openAdmin("/menus/main");

		await vi.waitFor(() =>
			expect(readTrail()).toEqual([{ label: "Menus", href: `${ADMIN}/menus` }, { loading: true }]),
		);
		menuLoaded.resolve();
		await vi.waitFor(() =>
			expect(readTrail()).toEqual([
				{ label: "Menus", href: `${ADMIN}/menus` },
				{ label: "Main navigation", current: "page" },
			]),
		);
	});

	it("falls back to the route's label when the menu doesn't exist", async () => {
		await openAdmin("/menus/missing");

		await expect.element(page.getByText("Menu not found")).toBeVisible();
		expect(readTrail()).toEqual([
			{ label: "Menus", href: `${ADMIN}/menus` },
			{ label: "Edit menu", current: "page" },
		]);
	});

	it("shows the route's label when the page never mounts, like plugin settings for an editor", async () => {
		role = ROLE_EDITOR;
		await openAdmin("/plugins-manager/seo/settings");

		await expect.element(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
		expect(readTrail()).toEqual([
			{ label: "Plugins", href: `${ADMIN}/plugins-manager` },
			{ label: "Plugin Settings", current: "page" },
		]);
	});

	it("shows no trail on a top-level page", async () => {
		await openAdmin("/menus");
		await expect.element(page.getByRole("heading", { name: "Menus", level: 1 })).toBeVisible();
		expect(document.querySelector("header nav")).toBeNull();
	});

	it("leaves the content editor's own bar in place of a trail", async () => {
		on("/_emdash/api/content/posts/post_1", () =>
			json({
				data: {
					item: {
						id: "post_1",
						type: "posts",
						slug: "hello",
						status: "draft",
						locale: "en",
						translationGroup: null,
						data: { title: "Hello" },
						authorId: null,
						primaryBylineId: null,
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						publishedAt: null,
						scheduledAt: null,
						liveRevisionId: null,
						draftRevisionId: null,
					},
				},
			}),
		);
		await openAdmin("/content/posts/post_1");

		await expect.element(page.getByRole("textbox", { name: "Title" })).toHaveValue("Hello");
		await expect.element(page.getByRole("link", { name: "Back to Posts list" })).toBeVisible();
		expect(document.querySelector("header nav")).toBeNull();
	});

	describe("media folders", () => {
		beforeEach(() => {
			role = ROLE_EDITOR;
			on("/_emdash/api/media/folders/folder_1", () => json({ data: { item: FOLDER } }));
			on("/_emdash/api/media/folders", () => json({ data: { items: [FOLDER] } }));
			on("/_emdash/api/media", () => json({ data: { items: [], totalCount: 0 } }));
			on("/_emdash/api/media/providers", () => json({ data: { items: [] } }));
		});

		it("adds the folder below Media, whose crumb goes back to the library", async () => {
			await openAdmin(`/media?folder=${FOLDER.id}`);

			await vi.waitFor(() =>
				expect(readTrail()).toEqual([
					{ label: "Media", href: `${ADMIN}/media` },
					{ label: "Product photos", current: "page" },
				]),
			);

			await trailNav().getByRole("link", { name: "Media", exact: true }).click();
			await vi.waitFor(() => expect(window.location.search).toBe(""));
			expect(window.location.pathname).toBe(`${ADMIN}/media`);
			await expect.element(trailNav()).not.toBeInTheDocument();
			await expect
				.element(page.getByRole("heading", { name: "Media Library", level: 1 }))
				.toHaveFocus();
		});

		it("keeps the way back to the library when the folder's name fails to load", async () => {
			on("/_emdash/api/media/folders/folder_1", () =>
				json({ error: { code: "INTERNAL_ERROR", message: "Failed" } }, 500),
			);
			await openAdmin(`/media?folder=${FOLDER.id}`);

			await vi.waitFor(
				() =>
					expect(readTrail()).toEqual([
						{ label: "Media", href: `${ADMIN}/media` },
						{ label: "Folder", current: "page" },
					]),
				{ timeout: 6000 },
			);

			await trailNav().getByRole("link", { name: "Media", exact: true }).click();
			await expect
				.element(page.getByRole("heading", { name: "Media Library", level: 1 }))
				.toHaveFocus();
		});

		it("keeps the folder's trail when the folder's media fails to load", async () => {
			on("/_emdash/api/media", () =>
				json({ error: { code: "INTERNAL_ERROR", message: "Failed" } }, 500),
			);
			await openAdmin(`/media?folder=${FOLDER.id}`);

			await vi.waitFor(
				() =>
					expect(readTrail()).toEqual([
						{ label: "Media", href: `${ADMIN}/media` },
						{ label: FOLDER.name, current: "page" },
					]),
				{ timeout: 6000 },
			);
		});

		it("moves focus to the library heading when the browser goes back to the library", async () => {
			await openAdmin("/media");
			await page.getByRole("link", { name: `Open folder ${FOLDER.name}` }).click();
			await vi.waitFor(() => expect(readTrail()).toHaveLength(2));

			const mediaCrumb = trailNav().getByRole("link", { name: "Media", exact: true });
			mediaCrumb.element().focus();
			await expect.element(mediaCrumb).toHaveFocus();
			window.history.back();

			await vi.waitFor(() => expect(window.location.search).toBe(""));
			await expect.element(trailNav()).not.toBeInTheDocument();
			await expect
				.element(page.getByRole("heading", { name: "Media Library", level: 1 }))
				.toHaveFocus();
		});
	});

	it("reads from the right in Arabic, with mirrored separators", async () => {
		await openAdmin("/settings/general", "ar");

		const nav = trailNav();
		await expect.element(nav).toBeVisible();
		expect(document.documentElement.dir).toBe("rtl");
		const trail = nav.element();
		const parent = visibleIn(trail, "a")!;
		const current = visibleIn(trail, "[aria-current='page']")!;
		expect(parent.textContent).toBe(i18n._(msg`Settings`));
		expect(current.textContent).toBe(i18n._(msg`General`));
		expect(parent.getBoundingClientRect().left).toBeGreaterThan(
			current.getBoundingClientRect().right,
		);
		expect(getComputedStyle(visibleIn(trail, "svg")!).rotate).toBe("180deg");
	});

	it("keeps the start of a Latin menu name visible when it truncates in Arabic", async () => {
		const label = "Primary navigation for the spring product launch campaign";
		on("/_emdash/api/menus/main", () => json({ data: menuWithLabel(label) }));
		await page.viewport(375, 800);
		await openAdmin("/menus/main", "ar");

		await vi.waitFor(() => expect(readTrail()?.at(-1)).toEqual({ label, current: "page" }));
		const name = visibleIn(trailNav().element(), "[aria-current='page'] [dir='auto']")!;
		expect(getComputedStyle(name).direction).toBe("ltr");
		expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
	});

	it("keeps the separator pointing forward in left-to-right pages", async () => {
		await openAdmin("/settings/general");

		const trail = trailNav();
		await expect.element(trail).toBeVisible();
		const separator = visibleIn(trail.element(), "svg")!;
		expect(getComputedStyle(separator).rotate).toBe("none");
	});

	it("truncates a long menu name at phone width without pushing the header actions off screen", async () => {
		manifest = { ...MANIFEST, staging: true };
		const label = "Primary navigation for the spring product launch campaign";
		on("/_emdash/api/menus/main", () => json({ data: menuWithLabel(label) }));
		await page.viewport(320, 800);
		await openAdmin("/menus/main");

		await vi.waitFor(() =>
			expect(readTrail()).toEqual([
				{ label: "Menus", href: `${ADMIN}/menus` },
				{ label, current: "page" },
			]),
		);
		const header = document.querySelector("header")!;
		const trail = trailNav().element();
		const menus = visibleIn(trail, "a")!;
		const name = visibleIn(trail, "[aria-current='page'] [dir='auto']")!;
		expect(menus.scrollWidth).toBeLessThanOrEqual(menus.clientWidth);
		expect(name.clientWidth).toBeGreaterThan(0);
		expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
		expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
		await expect.element(page.getByRole("link", { name: "Staging" })).toBeVisible();
		await expect.element(page.getByRole("link", { name: "View Site" })).toBeVisible();
		await expect.element(page.getByText("View Site")).not.toBeVisible();
		const userMenu = page.getByRole("button", { name: "Ada" }).element();
		expect(userMenu.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
	});
});
