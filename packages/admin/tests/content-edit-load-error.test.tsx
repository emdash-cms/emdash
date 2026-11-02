import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient, createMockFetch } from "./utils/test-helpers";

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
			fields: {
				title: { kind: "string", label: "Title" },
			},
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

const ITEM_URL = "/_emdash/api/content/posts/post_1";

function buildApp() {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) {
		i18n.loadAndActivate({ locale: "en", messages: {} });
	}
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
	return { router, queryClient, TestApp };
}

async function openEntry() {
	const { router, queryClient, TestApp } = buildApp();
	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	const screen = await render(<TestApp />);
	return Object.assign(screen, { queryClient });
}

function publishedPost() {
	return {
		id: "post_1",
		type: "posts",
		slug: "hello",
		status: "published",
		locale: "en",
		translationGroup: null,
		data: { title: "Hello" },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		publishedAt: "2025-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: "rev_1",
		draftRevisionId: "rev_1",
	};
}

describe("ContentEditPage when the entry fails to load", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/bylines", { data: { items: [] } })
			.on("GET", "/_emdash/api/users", { data: { items: [] } });
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("tells a subscriber that unpublished entries are hidden for their role", async () => {
		mockFetch
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 10 } })
			.on(
				"GET",
				ITEM_URL,
				{ error: { code: "NOT_FOUND", message: "Content item not found: post_1" } },
				404,
			);

		const screen = await openEntry();

		await expect.element(screen.getByRole("heading", { name: "Page Not Found" })).toBeVisible();
		await expect
			.element(screen.getByText("Your role can only view published content.", { exact: false }))
			.toBeVisible();
	});

	it("shows a not-found page without the role hint to a contributor", async () => {
		mockFetch
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 20 } })
			.on(
				"GET",
				ITEM_URL,
				{ error: { code: "NOT_FOUND", message: "Content item not found: post_1" } },
				404,
			);

		const screen = await openEntry();

		await expect
			.element(screen.getByText("This entry doesn't exist or was deleted."))
			.toBeVisible();
		expect(document.body.textContent).not.toContain("Your role can only view published content.");
	});

	it("shows the server error for other failures", async () => {
		mockFetch
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 40 } })
			.on(
				"GET",
				ITEM_URL,
				{ error: { code: "CONTENT_GET_ERROR", message: "Failed to get content" } },
				500,
			);

		const screen = await openEntry();

		await expect.element(screen.getByRole("heading", { name: "Error" })).toBeVisible();
		await expect.element(screen.getByText("Failed to get content")).toBeVisible();
	});

	it("keeps the open editor when a background refetch fails", async () => {
		mockFetch
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 40 } })
			.on("GET", "/_emdash/api/revisions", { data: { item: null } })
			.on("GET", ITEM_URL, { data: { item: publishedPost() } });

		const screen = await openEntry();
		const title = screen.getByRole("textbox", { name: "Title" });
		await expect.element(title).toHaveValue("Hello");

		mockFetch.on(
			"GET",
			ITEM_URL,
			{ error: { code: "CONTENT_GET_ERROR", message: "Failed to get content" } },
			500,
		);
		await screen.queryClient.refetchQueries({ queryKey: ["content", "posts", "post_1"] });
		// React Query notifies subscribers on a later tick.
		await new Promise((resolve) => setTimeout(resolve, 100));

		await expect.element(title).toHaveValue("Hello");
		expect(document.body.textContent).not.toContain("Failed to get content");
	});
});
