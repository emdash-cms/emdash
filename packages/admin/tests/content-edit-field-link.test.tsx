import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../dist/styles.css";
import { ThemeProvider } from "../src/components/ThemeProvider.js";
import type { AdminManifest } from "../src/lib/api/index.js";
import type { BlockType } from "../src/lib/api/schema.js";
import { createAdminRouter } from "../src/router.js";
import { render } from "./utils/render.js";
import { createMockFetch, createTestQueryClient } from "./utils/test-helpers.js";

const HERO_FIELDS = Array.from({ length: 10 }, (_, index) => `line_${index + 1}`);
type TestScreen = Awaited<ReturnType<typeof render>>;

const HERO: BlockType = {
	id: "hero-id",
	slug: "hero",
	label: "Hero",
	category: "Layout",
	currentVersion: 1,
	source: "user",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	versions: [
		{
			id: "hero-v1",
			blockTypeId: "hero-id",
			version: 1,
			fields: HERO_FIELDS.map((slug) => ({ slug, label: slug, type: "string" })),
			fingerprint: "hero-v1",
			active: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	],
};

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {
		pages: {
			label: "Pages",
			labelSingular: "Page",
			supports: ["drafts"],
			hasSeo: false,
			fields: {
				title: { kind: "string", label: "Title" },
				items: {
					kind: "repeater",
					label: "Items",
					validation: { subFields: [{ slug: "label", label: "Label", type: "string" }] },
				},
				content: {
					kind: "blocks",
					label: "Content",
					blockTypes: [HERO],
					validation: { allowedTypes: ["hero"] },
				},
			},
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

const PAGE = {
	id: "page_1",
	type: "pages",
	slug: "contact",
	status: "published",
	locale: "en",
	translationGroup: null,
	data: {
		title: "Contact",
		items: [{ label: "First item" }],
		content: Array.from({ length: 30 }, (_, index) => ({
			_type: "hero",
			_key: `block_${index + 1}`,
			_version: 1,
			line_1: "Talk to the team",
		})),
	},
	authorId: null,
	primaryBylineId: null,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	publishedAt: "2026-01-01T00:00:00Z",
	scheduledAt: null,
	liveRevisionId: null,
	draftRevisionId: null,
};

function buildApp() {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	function TestApp() {
		return (
			<I18nProvider i18n={i18n}>
				<ThemeProvider defaultTheme="light">
					<Toasty>
						<QueryClientProvider client={queryClient}>
							<RouterProvider router={router} />
						</QueryClientProvider>
					</Toasty>
				</ThemeProvider>
			</I18nProvider>
		);
	}
	return { router, TestApp };
}

function editorCanvasScrollEnd() {
	return new Promise<void>((resolve) => {
		document.addEventListener(
			"scrollend",
			function onScrollEnd(event) {
				if (
					event.target instanceof Element &&
					event.target.matches("[data-emdash-editor-canvas]")
				) {
					document.removeEventListener("scrollend", onScrollEnd, true);
					resolve();
				}
			},
			true,
		);
	});
}

describe("ContentEditPage opened from a field link on the site", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } })
			.on("GET", "/_emdash/api/content/pages/page_1", { data: { item: PAGE } })
			.on("GET", "/_emdash/api/admin/users", { data: { items: [] } })
			.on("GET", "/_emdash/api/admin/bylines", { data: { items: [] } });
	});

	afterEach(async () => {
		localStorage.removeItem("emdash-editor-settings-panel");
		await page.viewport(1280, 800);
		mockFetch.restore();
	});

	async function openField(field: string, locale = "en") {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field, locale },
		});
		const screen = await render(<TestApp />);
		return { router, screen };
	}

	it("focuses a top-level repeater subfield and clears only the field search parameter", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "items.0.label", locale: "en" },
		});
		const screen = await render(<TestApp />);

		await expect.element(screen.getByLabelText("Label")).toBeEnabled();
		await expect.poll(() => document.activeElement?.id).toBe("field-items.0.label");
		await expect.poll(() => router.state.location.search).toEqual({ locale: "en" });
	});

	it("focuses the linked field when the editor shows after the entry has loaded", async () => {
		const mockedFetch = globalThis.fetch;
		const joinHeld = Promise.withResolvers<void>();
		let joinRequested = false;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
			if (init?.method === "POST" && url.endsWith("/content/pages/page_1/room")) {
				joinRequested = true;
				await joinHeld.promise;
			}
			return mockedFetch(input, init);
		}) as typeof fetch;

		const { router } = await openField("items.0.label");
		await expect.poll(() => joinRequested).toBe(true);
		await new Promise((resolve) => requestIdleCallback(resolve));
		await new Promise((resolve) => requestIdleCallback(resolve));
		expect(document.getElementById("field-items.0.label")).toBeNull();
		joinHeld.resolve();

		await expect.poll(() => document.activeElement?.id).toBe("field-items.0.label");
		await expect.poll(() => router.state.location.search).toEqual({ locale: "en" });
	});

	it("keeps the legacy cleanup for a top-level file field wrapper", async () => {
		mockFetch.on("GET", "/_emdash/api/manifest", {
			data: {
				...MANIFEST,
				collections: {
					pages: {
						...MANIFEST.collections.pages,
						fields: {
							...MANIFEST.collections.pages.fields,
							attachment: { kind: "file", label: "Attachment" },
						},
					},
				},
			},
		});
		const { router } = await openField("attachment");
		await expect.poll(() => document.getElementById("field-attachment")?.tagName).toBe("DIV");
		await expect.poll(() => router.state.location.search).toEqual({ locale: "en" });
	});

	it.each([
		[
			"publishedAt",
			(screen: TestScreen) => screen.getByRole("button", { name: /^Change publication date:/ }),
		],
		["bylines", (screen: TestScreen) => screen.getByRole("button", { name: "Choose bylines" })],
		["slug", (screen: TestScreen) => screen.getByLabelText("Slug")],
	])("focuses the %s settings alias and preserves locale", async (field, getControl) => {
		localStorage.setItem("emdash-editor-settings-panel", "hidden");
		const { router, screen } = await openField(field);
		const control = getControl(screen);
		await expect.element(control).toBeInTheDocument();
		await expect.poll(() => document.activeElement).toBe(control.element());
		await expect.poll(() => router.state.location.search).toEqual({ locale: "en" });
		expect(localStorage.getItem("emdash-editor-settings-panel")).toBe("hidden");
		const panel = document.querySelector<HTMLElement>('aside[aria-label="Settings"]');
		expect(panel).not.toHaveAttribute("inert");
	});

	it("focuses the SEO settings alias and preserves locale", async () => {
		mockFetch.on("GET", "/_emdash/api/manifest", {
			data: {
				...MANIFEST,
				collections: {
					...MANIFEST.collections,
					pages: { ...MANIFEST.collections.pages, hasSeo: true },
				},
			},
		});
		localStorage.setItem("emdash-editor-settings-panel", "hidden");
		const { router, screen } = await openField("seo");
		const control = screen.getByLabelText("SEO Title");
		await expect.element(control).toBeInTheDocument();
		await expect.poll(() => document.activeElement).toBe(control.element());
		await expect.poll(() => router.state.location.search).toEqual({ locale: "en" });
		expect(localStorage.getItem("emdash-editor-settings-panel")).toBe("hidden");
		expect(document.querySelector('aside[aria-label="Settings"]')).not.toHaveAttribute("inert");
	});

	it("focuses a collection field named seo instead of the settings alias", async () => {
		mockFetch
			.on("GET", "/_emdash/api/manifest", {
				data: {
					...MANIFEST,
					collections: {
						...MANIFEST.collections,
						pages: {
							...MANIFEST.collections.pages,
							hasSeo: true,
							fields: {
								...MANIFEST.collections.pages.fields,
								seo: { kind: "string", label: "Custom SEO" },
							},
						},
					},
				},
			})
			.on("GET", "/_emdash/api/content/pages/page_1", {
				data: { item: { ...PAGE, data: { ...PAGE.data, seo: "Custom value" } } },
			});
		localStorage.setItem("emdash-editor-settings-panel", "hidden");
		const { router } = await openField("seo");
		await expect.poll(() => document.activeElement?.id).toBe("field-seo");
		await expect.poll(() => router.state.location.search).toEqual({ locale: "en" });
		expect(document.querySelector('aside[aria-label="Settings"]')).toHaveAttribute("inert");
	});

	it("opens the settings sheet for the slug alias on mobile", async () => {
		await page.viewport(390, 844);
		const { router, screen } = await openField("slug");
		const control = screen.getByLabelText("Slug");
		await expect.element(control).toBeInTheDocument();
		await expect.poll(() => document.activeElement).toBe(control.element());
		await expect.poll(() => router.state.location.search).toEqual({ locale: "en" });
		await expect
			.element(screen.getByRole("navigation", { name: "Settings", includeHidden: true }))
			.not.toHaveAttribute("inert");
	});

	it("keeps an unavailable SEO alias in the URL without focusing a control", async () => {
		const { router, screen } = await openField("seo");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(router.state.location.search).toEqual({ field: "seo", locale: "en" });
		expect(document.activeElement?.id).not.toBe("field-seo");
		expect(screen.getByLabelText("SEO Title", { exact: true }).query()).toBeNull();
	});

	it("scrolls to the field without pushing the editor bar under the header", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "content" },
		});
		const scrolledToField = editorCanvasScrollEnd();
		await render(<TestApp />);
		await scrolledToField;

		const header = document.querySelector("header")!;
		const bar = document.querySelector("[data-emdash-editor-bar]")!;
		expect(document.querySelector("[data-emdash-editor-canvas]")!.scrollTop).toBeGreaterThan(0);
		expect(header.getBoundingClientRect().top).toBe(0);
		expect(bar.getBoundingClientRect().top).toBe(header.getBoundingClientRect().bottom);
	});
});
