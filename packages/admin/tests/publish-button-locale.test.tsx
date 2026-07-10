/**
 * Reproduction for emdash-cms/emdash#1557 — "Bug with publish button when editing posts".
 *
 * Two reported symptoms, one root cause:
 *   1. After saving an edit to a published post, no "Publish changes" button appears
 *      until the page is refreshed.
 *   2. After refreshing and publishing, the button stays active ("Publish changes")
 *      instead of flipping to "Unpublish".
 *
 * Root cause (hypothesis under test):
 *   The editor reads the content item with the query key
 *       ["content", collection, id, { locale: activeLocale }]
 *   where `activeLocale` is `undefined` when i18n is NOT configured (router.tsx).
 *   The save/publish mutations, however, invalidate with
 *       ["content", collection, id, { locale: rawItem.locale ?? activeLocale }]
 *   and `rawItem.locale` is the DB default "en" even on non-i18n sites. React Query's
 *   partial matcher compares { locale: undefined } against { locale: "en" } and finds
 *   no match, so the invalidation never refetches the item. The editor keeps the stale
 *   draft-status pointers and the publish button never updates.
 *
 * This test drives the publish flow (symptom #2) because it needs no typing — just a
 * button click — but it exercises the exact same mismatched invalidation key as the
 * save flow (symptom #1).
 *
 * Expected: after publishing, the button becomes "Unpublish".
 * Actual (bug): the stale cache is never refetched, so it stays "Publish changes".
 *
 * NOTE: this file deliberately does NOT mock ContentEditor (unlike router.test.tsx),
 * so the real publish-button logic renders.
 */

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
import { createTestQueryClient, createMockFetch, waitFor } from "./utils/test-helpers";

// ---------------------------------------------------------------------------
// Fixtures — i18n is intentionally OFF, which is the condition that triggers
// the bug (activeLocale === undefined while rawItem.locale === "en").
// ---------------------------------------------------------------------------

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

/** A published post that has pending draft changes (live !== draft). */
function publishedWithChanges() {
	return {
		id: "post_1",
		type: "posts",
		slug: "published-slug",
		status: "published",
		locale: "en",
		translationGroup: null,
		data: { title: "Published Title" },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		publishedAt: "2025-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: "rev_live",
		draftRevisionId: "rev_draft",
	};
}

/** Same post after publishing: draft has been promoted to live (live === draft). */
function publishedNoChanges() {
	return {
		...publishedWithChanges(),
		updatedAt: "2025-01-02T00:00:00Z",
		publishedAt: "2025-01-02T00:00:00Z",
		liveRevisionId: "rev_draft",
		draftRevisionId: "rev_draft",
	};
}

function buildRouter() {
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

// ---------------------------------------------------------------------------

describe("ContentEditPage – publish button stays in sync after publishing (#1557)", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();

		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 30 } })
			.on("GET", "/_emdash/api/bylines", { data: { items: [] } })
			.on("GET", "/_emdash/api/users", { data: { items: [] } })
			// Initial state: published WITH pending draft changes -> "Publish changes" shows.
			.on("GET", "/_emdash/api/content/posts/post_1", { data: { item: publishedWithChanges() } })
			.on("GET", "/_emdash/api/revisions/rev_draft", {
				data: {
					item: {
						id: "rev_draft",
						collection: "posts",
						entryId: "post_1",
						data: { title: "Draft Title" },
						authorId: null,
						createdAt: "2025-01-01T00:00:00Z",
					},
				},
			})
			// Publishing succeeds; the server has now promoted the draft to live.
			.on("POST", "/_emdash/api/content/posts/post_1/publish", {
				data: { item: publishedNoChanges() },
			});
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("flips 'Publish changes' to 'Unpublish' after a successful publish", async () => {
		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});

		const screen = await render(<TestApp />);

		// The editor loads in the published-with-changes state.
		const publishBtn = screen.getByRole("button", { name: "Publish changes" });
		await expect.element(publishBtn).toBeInTheDocument();

		// After this point the server reports no pending changes (live === draft),
		// so a refetch would reveal the post is fully published.
		mockFetch.on("GET", "/_emdash/api/content/posts/post_1", {
			data: { item: publishedNoChanges() },
		});

		await publishBtn.click();

		// Wait for the publish toast so we know the mutation's onSuccess has run
		// (this is where the cache invalidation fires).
		await waitFor(() => {
			expect(document.body.textContent).toContain("Content is now live");
		});

		// The button must now reflect the published state. With the locale-key
		// mismatch the invalidation matches nothing, the stale item is never
		// refetched, and this assertion fails because "Publish changes" is still
		// shown instead of "Unpublish".
		await expect.element(screen.getByRole("button", { name: "Unpublish" })).toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------

/** A published post with no pending changes (live === draft). */
function publishedClean() {
	return {
		id: "post_1",
		type: "posts",
		slug: "published-slug",
		status: "published",
		locale: "en",
		translationGroup: null,
		data: { title: "Published Title" },
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

/** Same post after editing + saving: a new draft revision now exists (live !== draft). */
function publishedDirty() {
	return {
		...publishedClean(),
		updatedAt: "2025-01-02T00:00:00Z",
		draftRevisionId: "rev_2",
	};
}

describe("ContentEditPage – publish button appears after saving an edit (#1557)", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();

		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 30 } })
			.on("GET", "/_emdash/api/bylines", { data: { items: [] } })
			.on("GET", "/_emdash/api/users", { data: { items: [] } })
			// Initial state: published, no pending changes -> "Unpublish" shows, no
			// "Publish changes" button.
			.on("GET", "/_emdash/api/content/posts/post_1", { data: { item: publishedClean() } })
			.on("GET", "/_emdash/api/revisions/rev_1", {
				data: {
					item: {
						id: "rev_1",
						collection: "posts",
						entryId: "post_1",
						data: { title: "Published Title" },
						authorId: null,
						createdAt: "2025-01-01T00:00:00Z",
					},
				},
			})
			.on("GET", "/_emdash/api/revisions/rev_2", {
				data: {
					item: {
						id: "rev_2",
						collection: "posts",
						entryId: "post_1",
						data: { title: "Published Title edited" },
						authorId: null,
						createdAt: "2025-01-02T00:00:00Z",
					},
				},
			})
			// The PUT response itself reports no pending changes, so that an incidental
			// autosave (which patches the cache directly) cannot surface the button on
			// its own — only the manual-save invalidation + refetch of the GET below can.
			.on("PUT", "/_emdash/api/content/posts/post_1", { data: { item: publishedClean() } });
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("shows 'Publish changes' after editing the title and saving", async () => {
		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});

		const screen = await render(<TestApp />);

		// Loads in the clean published state: "Unpublish" present, no "Publish changes".
		await expect.element(screen.getByRole("button", { name: "Unpublish" })).toBeInTheDocument();

		// Edit the title so the form is dirty and Save becomes enabled.
		const titleInput = screen.getByRole("textbox", { name: "Title" });
		await titleInput.fill("Published Title edited");

		// From now on the server reports a pending draft revision (live !== draft).
		mockFetch.on("GET", "/_emdash/api/content/posts/post_1", { data: { item: publishedDirty() } });

		// Two SaveButtons render (header + end-of-form); both submit the same form.
		await screen.getByRole("button", { name: "Save", exact: true }).first().click();

		// After saving, the editor must offer to publish the new draft. With the
		// locale-key mismatch the invalidation matches nothing, the item is never
		// refetched, and this assertion fails because no "Publish changes" button
		// is rendered until a hard refresh.
		await expect
			.element(screen.getByRole("button", { name: "Publish changes" }))
			.toBeInTheDocument();
	});
});
