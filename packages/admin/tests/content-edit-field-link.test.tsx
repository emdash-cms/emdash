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

const HERO_FIELDS = [...Array.from({ length: 10 }, (_, index) => `line_${index + 1}`), "anchor_id"];

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
			fields: [
				...HERO_FIELDS.map((slug) => ({
					slug,
					label: slug,
					type: "string" as const,
					required: slug === "line_3",
				})),
				{
					slug: "items",
					label: "Items",
					type: "repeater",
					validation: {
						subFields: [
							{ slug: "label", label: "Label", type: "string" },
							{ slug: "description", label: "Description", type: "text" },
						],
					},
				},
			],
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
		content: Array.from({ length: 30 }, (_, index) => ({
			_type: "hero",
			_key: `block_${index + 1}`,
			_version: 1,
			line_1: "Talk to the team",
			items: [
				{ label: "First", description: "First item" },
				{ label: "Second", description: "Second item" },
			],
			anchor_id: index === 24 ? "pricing" : undefined,
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

describe("ContentEditPage opened from a field link on the site", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } })
			.on("GET", "/_emdash/api/content/pages/page_1", { data: { item: PAGE } });
	});

	afterEach(async () => {
		mockFetch.restore();
		await page.viewport(1280, 800);
	});

	it("opens a collapsed block and focuses the requested field, not its validation issue", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "content.block_25.line_2", locale: "en" },
		});
		await render(<TestApp />);
		await expect.poll(() => document.activeElement?.id).toBe("field-content.block_25.line_2");
		expect(
			document.getElementById("field-content.block_25.line_3")?.getAttribute("aria-invalid"),
		).not.toBe("true");
		await expect.poll(() => router.state.location.search).toEqual({ locale: "en" });
		expect(document.querySelector('[data-block-key="block_24"] [data-block-body]')).toBeNull();
	});

	it("opens the block Advanced section for an advanced field and focuses that field", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "content.block_25.anchor_id", locale: "en" },
		});
		await render(<TestApp />);
		await expect.poll(() => document.activeElement?.id).toBe("field-content.block_25.anchor_id");
		await expect
			.poll(() => document.querySelector('[data-block-key="block_25"] [data-block-body]'))
			.not.toBeNull();
		await expect.poll(() => router.state.location.search.field).toBeUndefined();
		expect(document.querySelector('[data-block-key="block_24"] [data-block-body]')).toBeNull();
	});

	it.each([
		["publishedAt", "publish"],
		["bylines", "bylines"],
		["slug", "url-language"],
	])("focuses the settings control for %s", async (field, section) => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field },
		});
		await render(<TestApp />);
		await expect
			.poll(() =>
				document.activeElement
					?.closest("[data-settings-section]")
					?.getAttribute("data-settings-section"),
			)
			.toBe(section);
		if (field === "publishedAt") {
			expect(document.activeElement?.closest('[data-emdash-outside="publishedAt"]')).not.toBeNull();
		}
		await expect.poll(() => router.state.location.search.field).toBeUndefined();
	});

	it("opens a nested repeater item and focuses its requested sub-field", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "content.block_25.items.1.description" },
		});
		await render(<TestApp />);
		await expect
			.poll(() => document.activeElement?.id)
			.toBe("field-content.block_25.items.1.description");
		await expect.poll(() => router.state.location.search.field).toBeUndefined();
		expect(document.getElementById("field-content.block_25.items.0.description")).toBeNull();
		await router.navigate({ search: { field: "content.block_25.items.0.description" } });
		await expect
			.poll(() => document.activeElement?.id)
			.toBe("field-content.block_25.items.0.description");
		await expect.poll(() => router.state.location.search.field).toBeUndefined();
		const toggle = document.querySelector<HTMLElement>(
			'[data-block-key="block_25"] [data-block-toggle]',
		)!;
		toggle.click();
		await expect
			.poll(() => document.getElementById("field-content.block_25.items.0.description"))
			.toBeNull();
		toggle.click();
		await expect
			.poll(() => document.querySelector('[data-block-key="block_25"] [data-block-body]'))
			.not.toBeNull();
		expect(document.getElementById("field-content.block_25.items.0.description")).toBeNull();
	});

	it("focuses bylines from the mobile settings sheet rather than a help control", async () => {
		await page.viewport(390, 844);
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "bylines" },
		});
		await render(<TestApp />);
		await expect
			.poll(() =>
				document.activeElement
					?.closest("[data-settings-section]")
					?.getAttribute("data-settings-section"),
			)
			.toBe("bylines");
		expect(
			document.activeElement?.matches("button"),
			"the bylines editor should receive focus",
		).toBe(true);
		expect(document.activeElement?.closest("[data-settings-control]")).not.toBeNull();
		await expect.poll(() => router.state.location.search.field).toBeUndefined();
	});

	it("handles successive field links without remounting the editor", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "bylines" },
		});
		await render(<TestApp />);
		await expect
			.poll(() =>
				document.activeElement
					?.closest("[data-settings-section]")
					?.getAttribute("data-settings-section"),
			)
			.toBe("bylines");

		await router.navigate({ search: { field: "publishedAt" } });
		await expect
			.poll(() =>
				document.activeElement
					?.closest("[data-settings-section]")
					?.getAttribute("data-settings-section"),
			)
			.toBe("publish");
		expect(document.activeElement?.closest('[data-emdash-outside="publishedAt"]')).not.toBeNull();
		await expect.poll(() => router.state.location.search.field).toBeUndefined();
	});

	it("focuses the SEO title rather than the image or noindex controls", async () => {
		mockFetch.on("GET", "/_emdash/api/manifest", {
			data: {
				...MANIFEST,
				collections: { pages: { ...MANIFEST.collections.pages, hasSeo: true } },
			},
		});
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "seo" },
		});
		const screen = await render(<TestApp />);
		await expect
			.element(screen.getByRole("textbox", { name: "SEO Title", exact: true }))
			.toHaveFocus();
	});

	it("keeps custom seo field links targeting the collection field", async () => {
		mockFetch.on("GET", "/_emdash/api/manifest", {
			data: {
				...MANIFEST,
				collections: {
					pages: {
						...MANIFEST.collections.pages,
						fields: {
							...MANIFEST.collections.pages.fields,
							seo: { kind: "string", label: "Custom SEO" },
						},
					},
				},
			},
		});
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "seo" },
		});
		await render(<TestApp />);
		await expect
			.element(page.getByRole("textbox", { name: "Custom SEO", exact: true }))
			.toHaveFocus();
		await expect.poll(() => router.state.location.search.field).toBeUndefined();
	});

	it("allows closing mobile settings when the requested section is unavailable", async () => {
		await page.viewport(390, 844);
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "seo" },
		});
		const screen = await render(<TestApp />);
		await expect.element(screen.getByRole("button", { name: "Close settings" })).toBeVisible();
		await screen.getByRole("button", { name: "Close settings" }).click();
		await expect
			.poll(() => document.getAnimations().filter((a) => a.playState === "running").length)
			.toBe(0);
		await expect
			.poll(() => screen.getByRole("button", { name: "Close settings" }).query())
			.toBeNull();
		expect(router.state.location.search.field).toBe("seo");
	});

	it("focuses the Publish section rather than an unrelated action when no publication date exists", async () => {
		mockFetch.on("GET", "/_emdash/api/content/pages/page_1", {
			data: { item: { ...PAGE, status: "draft", publishedAt: null } },
		});
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "publishedAt" },
		});
		await render(<TestApp />);
		await expect
			.poll(() => document.activeElement?.getAttribute("data-settings-section"))
			.toBe("publish");
	});

	it("exits distraction-free mode to reveal a linked settings control", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
		});
		const screen = await render(<TestApp />);
		await screen.getByRole("button", { name: "Enter distraction-free mode" }).click();
		await router.navigate({ search: { field: "bylines" } });
		await expect
			.poll(() => document.activeElement?.closest("[data-settings-control]"))
			.not.toBeNull();
		await expect
			.element(screen.getByRole("button", { name: "Enter distraction-free mode" }))
			.toBeVisible();
	});

	it("does not block distraction-free mode for an unavailable settings section", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "seo" },
		});
		const screen = await render(<TestApp />);
		await screen.getByRole("button", { name: "Enter distraction-free mode" }).click();
		await expect
			.element(screen.getByRole("button", { name: "Exit distraction-free mode" }))
			.toBeVisible();
		expect(router.state.location.search.field).toBe("seo");
	});

	it("leaves unknown paths alone", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "content.missing.line_1" },
		});
		const screen = await render(<TestApp />);
		await expect.element(screen.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
		expect(router.state.location.search.field).toBe("content.missing.line_1");
	});

	it("focuses an empty field wrapper when it has no interactive controls", async () => {
		mockFetch.on("GET", "/_emdash/api/auth/me", { data: { id: "user_02", role: 10 } });
		mockFetch.on("GET", "/_emdash/api/manifest", {
			data: {
				...MANIFEST,
				collections: {
					pages: {
						...MANIFEST.collections.pages,
						fields: {
							content: {
								...MANIFEST.collections.pages.fields.content,
								validation: { allowedTypes: [] },
							},
						},
					},
				},
			},
		});
		mockFetch.on("GET", "/_emdash/api/content/pages/page_1", {
			data: { item: { ...PAGE, data: { content: [] } } },
		});
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "content" },
		});
		await render(<TestApp />);
		await expect.poll(() => document.activeElement?.id).toBe("field-content");
		await expect.poll(() => router.state.location.search.field).toBeUndefined();
	});

	it("scrolls to the field without pushing the editor bar under the header", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "pages", id: "page_1" },
			search: { field: "content" },
		});
		await render(<TestApp />);
		await expect
			.poll(() => document.querySelector("[data-emdash-editor-canvas]")?.scrollTop ?? 0)
			.toBeGreaterThan(0);
		await expect.poll(() => router.state.location.search.field).toBeUndefined();
		expect(document.getElementById("field-content")?.contains(document.activeElement)).toBe(true);

		const header = document.querySelector("header")!;
		const bar = document.querySelector("[data-emdash-editor-bar]")!;
		expect(document.querySelector("[data-emdash-editor-canvas]")!.scrollTop).toBeGreaterThan(0);
		expect(header.getBoundingClientRect().top).toBe(0);
		expect(bar.getBoundingClientRect().top).toBe(header.getBoundingClientRect().bottom);
	});
});
