import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "../src/components/ThemeProvider.js";
import type { AdminManifest } from "../src/lib/api/index.js";
import { createAdminRouter } from "../src/router.js";
import { render } from "./utils/render.js";
import { createMockFetch, createTestQueryClient } from "./utils/test-helpers.js";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
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
	i18n: undefined,
};

const CREATED = {
	id: "post_new",
	type: "posts",
	slug: "unsaved-title",
	status: "draft",
	locale: "en",
	translationGroup: null,
	data: { title: "Unsaved title" },
	authorId: null,
	primaryBylineId: null,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	publishedAt: null,
	scheduledAt: null,
	liveRevisionId: null,
	draftRevisionId: null,
};

async function renderNewEntry() {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });

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

	await router.navigate({ to: "/content/$collection/new", params: { collection: "posts" } });
	const screen = await render(<TestApp />);
	const title = screen.getByRole("textbox", { name: "Title", exact: true });
	await expect.element(title).toBeVisible();
	return { router, screen, title };
}

function leaveForPostList(router: ReturnType<typeof createAdminRouter>) {
	return router.navigate({ to: "/content/$collection", params: { collection: "posts" } });
}

describe("leaving the content editor", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } })
			.on("GET", "/_emdash/api/bylines", { data: { items: [], nextCursor: null } })
			.on("GET", "/_emdash/api/content/posts?", { data: { items: [], nextCursor: null } })
			.on("POST", "/_emdash/api/content/posts", { data: { item: CREATED, _rev: "rev-1" } })
			.on("GET", "/_emdash/api/content/posts/post_new", { data: { item: CREATED } });
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("leaves an untouched new entry without asking", async () => {
		const { router, screen } = await renderNewEntry();

		await leaveForPostList(router);

		expect(router.state.location.pathname).toMatch(/\/content\/posts$/);
		expect(screen.container.ownerDocument.querySelector('[role="dialog"]')).toBeNull();
	});

	it("asks before discarding typed content, and stays when told to", async () => {
		const { router, screen, title } = await renderNewEntry();
		await title.fill("Unsaved title");

		// A navigation the blocker cancels never settles, so it is not awaited.
		void leaveForPostList(router);
		const dialog = screen.getByRole("dialog");
		await expect.element(dialog).toHaveTextContent("Leave without saving?");
		screen.getByRole("button", { name: "Stay" }).element().click();
		await expect.element(dialog).not.toBeInTheDocument();

		expect(router.state.location.pathname).toMatch(/\/content\/posts\/new$/);
		await expect.element(title).toHaveValue("Unsaved title");

		const left = leaveForPostList(router);
		await expect.element(screen.getByRole("dialog")).toBeVisible();
		screen.getByRole("button", { name: "Leave" }).element().click();
		await left;

		expect(router.state.location.pathname).toMatch(/\/content\/posts$/);
	});

	it("asks the browser to confirm a reload once the entry has changes", async () => {
		const { title } = await renderNewEntry();
		const reload = () => {
			const event = new Event("beforeunload", { cancelable: true });
			window.dispatchEvent(event);
			return event.defaultPrevented;
		};

		expect(reload()).toBe(false);
		await title.fill("Unsaved title");
		await expect.poll(reload).toBe(true);
	});

	it("opens the created entry after Save without asking", async () => {
		const { router, screen, title } = await renderNewEntry();
		await title.fill("Unsaved title");

		screen.getByRole("button", { name: "Save" }).element().click();

		await expect.poll(() => router.state.location.pathname).toMatch(/\/content\/posts\/post_new$/);
		expect(screen.container.ownerDocument.querySelector('[role="dialog"]')).toBeNull();
	});
});
