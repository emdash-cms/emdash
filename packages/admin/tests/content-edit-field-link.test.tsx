import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../dist/styles.css";
import { ThemeProvider } from "../src/components/ThemeProvider.js";
import type { AdminManifest } from "../src/lib/api/index.js";
import type { BlockType } from "../src/lib/api/schema.js";
import { createAdminRouter } from "../src/router.js";
import { render } from "./utils/render.js";
import { createMockFetch, createTestQueryClient } from "./utils/test-helpers.js";

const HERO_FIELDS = Array.from({ length: 10 }, (_, index) => `line_${index + 1}`);

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
		content: [{ _type: "hero", _key: "block_1", _version: 1, line_1: "Talk to the team" }],
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
			.on("GET", "/_emdash/api/content/pages/page_1", { data: { item: PAGE } });
	});

	afterEach(() => {
		mockFetch.restore();
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
