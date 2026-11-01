/**
 * Confirmations that send a request stay open until it lands, and a failure
 * shows inside the confirmation instead of closing it to a toast.
 */

import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminManifest } from "../../src/lib/api";
import { createAdminRouter } from "../../src/router";
import { render } from "../utils/render.tsx";
import { createMockFetch, createTestQueryClient } from "../utils/test-helpers";

vi.mock("../../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../src/components/AdminCommandPalette", () => ({
	AdminCommandPalette: () => null,
}));

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

const SERVER_MESSAGE = "Something went wrong on the server";
const FAILURE = { error: { code: "INTERNAL_ERROR", message: SERVER_MESSAGE } };

const POST = {
	id: "post_1",
	type: "posts",
	slug: "first-post",
	status: "draft",
	locale: "en",
	translationGroup: null,
	data: { title: "First post" },
	authorId: null,
	primaryBylineId: null,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	publishedAt: null,
	scheduledAt: null,
	liveRevisionId: null,
	draftRevisionId: null,
};

async function renderAt(open: (router: ReturnType<typeof createAdminRouter>) => Promise<void>) {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
	await open(router);
	return render(
		<I18nProvider i18n={i18n}>
			<Toasty>
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>
			</Toasty>
		</I18nProvider>,
	);
}

describe("confirmations report their own failures", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch()
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } });
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("keeps Delete Content Type? open with the failure, then closes once a retry lands", async () => {
		const url = "/_emdash/api/schema/collections/posts?force=true";
		mockFetch
			.on("GET", "/_emdash/api/schema/collections", {
				data: {
					items: [
						{
							id: "col_01",
							slug: "posts",
							label: "Posts",
							labelSingular: "Post",
							supports: ["drafts"],
							source: "dashboard",
							createdAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					],
				},
			})
			.on("GET", "/_emdash/api/schema/orphans", { data: { items: [] } })
			.on("GET", "/_emdash/api/schema/block-types", { data: { items: [] } })
			.on("GET", "/_emdash/api/relations", { data: { relations: [] } })
			.on("DELETE", url, FAILURE, 500);
		const screen = await renderAt((router) => router.navigate({ to: "/content-types" }));

		await screen.getByRole("button", { name: "Actions for Posts" }).click();
		await screen.getByRole("menuitem", { name: "Delete Posts" }).click();
		const dialog = screen.getByRole("dialog", { name: "Delete Content Type?" });
		await expect.element(dialog).toBeVisible();
		dialog.getByRole("button", { name: "Delete", exact: true }).element().click();

		await expect.element(dialog.getByRole("alert")).toHaveTextContent(SERVER_MESSAGE);

		mockFetch.on("DELETE", url, { data: {} });
		dialog.getByRole("button", { name: "Delete", exact: true }).element().click();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("keeps Delete Comment? open with the failure rather than closing to a toast", async () => {
		mockFetch
			.on("GET", "/_emdash/api/admin/comments/counts", {
				data: { pending: 1, approved: 0, spam: 0, trash: 0 },
			})
			.on("GET", "/_emdash/api/admin/comments", {
				data: {
					items: [
						{
							id: "comment_1",
							collection: "posts",
							contentId: "post_1",
							parentId: null,
							authorName: "Jordan Reader",
							authorEmail: "jordan@example.com",
							authorUserId: null,
							body: "Thanks for writing this up.",
							status: "pending",
							ipHash: null,
							userAgent: null,
							moderationMetadata: null,
							createdAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					],
				},
			})
			.on("DELETE", "/_emdash/api/admin/comments/comment_1", FAILURE, 500);
		const screen = await renderAt((router) => router.navigate({ to: "/comments" }));

		await screen.getByRole("button", { name: "Actions for comment by Jordan Reader" }).click();
		await screen.getByRole("menuitem", { name: "Delete permanently" }).click();
		const dialog = screen.getByRole("dialog", { name: "Delete Comment?" });
		await expect.element(dialog).toBeVisible();
		dialog.getByRole("button", { name: "Delete", exact: true }).element().click();

		await expect.element(dialog.getByRole("alert")).toHaveTextContent(SERVER_MESSAGE);
		expect(screen.getByText("Failed to delete comment").query()).toBeNull();
	});

	describe("the content list", () => {
		beforeEach(() => {
			mockFetch
				.on("GET", "/_emdash/api/content/posts/trash", {
					data: {
						items: [
							{
								...POST,
								id: "post_2",
								data: { title: "Old post" },
								deletedAt: "2026-01-02T00:00:00Z",
							},
						],
					},
				})
				.on("GET", "/_emdash/api/content/posts", { data: { items: [POST] } });
		});

		it("keeps a row's Move to Trash? open with the failure", async () => {
			mockFetch.on("DELETE", "/_emdash/api/content/posts/post_1", FAILURE, 500);
			const screen = await renderAt((router) =>
				router.navigate({ to: "/content/$collection", params: { collection: "posts" } }),
			);

			await screen.getByRole("button", { name: "Actions for First post" }).click();
			await screen.getByRole("menuitem", { name: "Move to trash" }).click();
			const dialog = screen.getByRole("dialog", { name: "Move to Trash?" });
			await expect.element(dialog).toBeVisible();
			dialog.getByRole("button", { name: "Move to Trash" }).element().click();

			await expect.element(dialog.getByRole("alert")).toHaveTextContent(SERVER_MESSAGE);
			expect(screen.getByText("Failed to delete", { exact: true }).query()).toBeNull();
		});

		it("keeps Delete Permanently? open with the failure, then closes once a retry lands", async () => {
			const url = "/_emdash/api/content/posts/post_2/permanent";
			mockFetch.on("DELETE", url, FAILURE, 500);
			const screen = await renderAt((router) =>
				router.navigate({ to: "/content/$collection", params: { collection: "posts" } }),
			);

			await screen.getByRole("tab", { name: /Trash/ }).click();
			await screen.getByRole("button", { name: "Actions for Old post" }).click();
			await screen.getByRole("menuitem", { name: "Delete permanently" }).click();
			const dialog = screen.getByRole("dialog", { name: "Delete Permanently?" });
			await expect.element(dialog).toBeVisible();
			dialog.getByRole("button", { name: "Delete Permanently" }).element().click();

			await expect.element(dialog.getByRole("alert")).toHaveTextContent(SERVER_MESSAGE);
			expect(screen.getByText("Failed to delete", { exact: true }).query()).toBeNull();

			mockFetch.on("DELETE", url, { data: {} });
			dialog.getByRole("button", { name: "Delete Permanently" }).element().click();
			await expect.element(dialog).not.toBeInTheDocument();
		});
	});

	describe("the content editor", () => {
		const PUBLISHED = {
			...POST,
			status: "published",
			publishedAt: "2026-01-01T00:00:00Z",
			liveRevisionId: "revision-live",
			draftRevisionId: "revision-draft",
		};

		beforeEach(() => {
			mockFetch
				.on("GET", "/_emdash/api/bylines", { data: { items: [], nextCursor: null } })
				.on("GET", "/_emdash/api/content/posts/post_1", { data: { item: PUBLISHED } });
		});

		async function openEntry() {
			const screen = await renderAt((router) =>
				router.navigate({
					to: "/content/$collection/$id",
					params: { collection: "posts", id: "post_1" },
				}),
			);
			await expect
				.element(screen.getByRole("textbox", { name: "Title", exact: true }))
				.toBeVisible();
			return screen;
		}

		it("keeps Move to Trash? open with the failure", async () => {
			mockFetch.on("DELETE", "/_emdash/api/content/posts/post_1?locale=en", FAILURE, 500);
			const screen = await openEntry();

			screen.getByRole("button", { name: "Move to Trash" }).element().click();
			const dialog = screen.getByRole("dialog", { name: "Move to Trash?" });
			await expect.element(dialog).toBeVisible();
			dialog.getByRole("button", { name: "Move to Trash" }).element().click();

			await expect.element(dialog.getByRole("alert")).toHaveTextContent(SERVER_MESSAGE);
			expect(screen.getByText("Failed to delete", { exact: true }).query()).toBeNull();
		});

		it("closes Move to Trash? when the lock explains the refusal, and shows the lock notice", async () => {
			mockFetch.on(
				"DELETE",
				"/_emdash/api/content/posts/post_1?locale=en",
				{
					error: {
						code: "ENTRY_LOCKED",
						message: "Someone else is editing this entry.",
						details: { userId: "user_02", userName: "Riley" },
					},
				},
				409,
			);
			const screen = await openEntry();

			screen.getByRole("button", { name: "Move to Trash" }).element().click();
			const dialog = screen.getByRole("dialog", { name: "Move to Trash?" });
			await expect.element(dialog).toBeVisible();
			dialog.getByRole("button", { name: "Move to Trash" }).element().click();

			await expect.element(dialog).not.toBeInTheDocument();
			await expect.element(screen.getByText("You no longer hold this entry")).toBeVisible();
		});

		it("keeps Discard draft changes? open with the failure", async () => {
			mockFetch.on(
				"POST",
				"/_emdash/api/content/posts/post_1/discard-draft?locale=en",
				FAILURE,
				500,
			);
			const screen = await openEntry();

			screen.getByRole("button", { name: "Discard changes", exact: true }).element().click();
			const dialog = screen.getByRole("dialog", { name: "Discard draft changes?" });
			await expect.element(dialog).toBeVisible();
			dialog.getByRole("button", { name: "Discard changes", exact: true }).element().click();

			await expect.element(dialog.getByRole("alert")).toHaveTextContent(SERVER_MESSAGE);
			expect(screen.getByText("Failed to discard changes").query()).toBeNull();
		});

		it("keeps Change publication date open with the failure, and raises no toast", async () => {
			mockFetch.on("PUT", "/_emdash/api/content/posts/post_1?locale=en", FAILURE, 500);
			const screen = await openEntry();

			screen
				.getByRole("button", { name: /Change publication date:/ })
				.element()
				.click();
			const dialog = screen.getByRole("dialog", { name: "Change publication date" });
			await expect.element(dialog).toBeVisible();
			await dialog.getByRole("textbox", { name: "Minute" }).fill("45");
			dialog.getByRole("button", { name: "Save date" }).element().click();

			await expect
				.element(dialog.getByRole("alert").filter({ hasText: SERVER_MESSAGE }))
				.toBeVisible();
			expect(screen.getByText("Failed to save", { exact: true }).query()).toBeNull();
		});

		it("keeps the schedule dialog open with the failure, and raises no toast", async () => {
			mockFetch.on("POST", "/_emdash/api/content/posts/post_1/schedule?locale=en", FAILURE, 500);
			const screen = await openEntry();

			screen.getByRole("button", { name: "Schedule", exact: true }).element().click();
			const dialog = screen.getByRole("dialog", { name: "Schedule changes" });
			await expect.element(dialog).toBeVisible();
			dialog.getByRole("button", { name: "Schedule changes" }).element().click();

			await expect
				.element(dialog.getByRole("alert").filter({ hasText: SERVER_MESSAGE }))
				.toBeVisible();
			expect(screen.getByText("Failed to schedule").query()).toBeNull();
		});
	});
});
