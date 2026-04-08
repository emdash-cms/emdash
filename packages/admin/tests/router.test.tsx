/**
 * Tests for admin router page components.
 *
 * Bug: content created in the wrong locale when using the locale switcher.
 *
 * Root cause (two parts):
 *   1. ContentListPage renders ContentList with `activeLocale` but the "Add New"
 *      <Link> in ContentList does NOT forward `search={{ locale: activeLocale }}` to
 *      the new-content route.  The locale is silently dropped on navigation.
 *   2. ContentNewPage (router.tsx:380) has no `validateSearch` and never reads the
 *      locale from URL search params, so `createContent` is always called without a
 *      locale, defaulting to English regardless of what is configured.
 *
 * Fix required in:
 *   packages/admin/src/components/ContentList.tsx     – forward locale on Add-New links
 *   packages/admin/src/router.tsx (ContentNewPage)    – read locale from search params
 *                                                       and pass it to createContent
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Toasty } from "@cloudflare/kumo";

import { createAdminRouter } from "../src/router";
import { createTestQueryClient, createMockFetch } from "./utils/test-helpers";
import type { AdminManifest } from "../src/lib/api";

// ---------------------------------------------------------------------------
// Component mocks – keep layout plumbing out of these tests
// ---------------------------------------------------------------------------

vi.mock("../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="shell">{children}</div>
	),
}));

vi.mock("../src/components/AdminCommandPalette", () => ({
	AdminCommandPalette: () => null,
}));

vi.mock("../src/components/ContentEditor", () => ({
	ContentEditor: ({
		onSave,
	}: {
		onSave: (payload: { data: Record<string, unknown> }) => void;
	}) => (
		<form
			data-testid="content-editor"
			onSubmit={(e) => {
				e.preventDefault();
				onSave({ data: { title: "Test Post" } });
			}}
		>
			<button type="submit">Save</button>
		</form>
	),
}));

// ---------------------------------------------------------------------------
// Fixtures
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
	i18n: {
		defaultLocale: "en",
		locales: ["en", "fr", "de"],
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRouter() {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	// Toasty is provided by App.tsx (outside RouterProvider) in production.
	// Mirror that here so Toast.useToastManager() works inside page components.
	function TestApp() {
		return (
			<Toasty>
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>
			</Toasty>
		);
	}
	return { router, queryClient, TestApp };
}

// ---------------------------------------------------------------------------
// Tests: ContentListPage – locale forwarded to "Add New" link
// ---------------------------------------------------------------------------

describe("ContentListPage – locale forwarding to the new-content route", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();

		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", {
				data: { id: "user_01", role: 60 },
			})
			.on("GET", "/_emdash/api/content/posts", {
				data: { items: [], nextCursor: undefined },
			})
			.on("GET", "/_emdash/api/content/posts/trashed", {
				data: { items: [] },
			});
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("Add New link includes the active locale when a non-default locale is selected", async () => {
		// Navigate to the content list with locale=fr selected in the switcher.
		// After the fix the "Add New" <Link> must carry ?locale=fr so that
		// ContentNewPage receives it and creates content in French, not English.
		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection",
			params: { collection: "posts" },
			search: { locale: "fr" },
		});

		const screen = await render(<TestApp />);

		const addNewLink = await screen.getByRole("link", { name: /add new/i });
		await expect.element(addNewLink).toBeInTheDocument();

		const href = addNewLink.element().getAttribute("href") ?? "";
		expect(href).toContain("locale=fr");
	});

	it("Add New link does not include a locale param when i18n is not configured", async () => {
		const manifestWithoutI18n: AdminManifest = { ...MANIFEST, i18n: undefined };
		mockFetch.on("GET", "/_emdash/api/manifest", { data: manifestWithoutI18n });

		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection",
			params: { collection: "posts" },
		});

		const screen = await render(<TestApp />);

		const addNewLink = await screen.getByRole("link", { name: /add new/i });
		await expect.element(addNewLink).toBeInTheDocument();

		const href = addNewLink.element().getAttribute("href") ?? "";
		expect(href).not.toContain("locale=");
	});
});

// ---------------------------------------------------------------------------
// Tests: ContentNewPage – locale passed to createContent
// ---------------------------------------------------------------------------

describe("ContentNewPage – locale passed to createContent", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();

		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", {
				data: { id: "user_01", role: 60 },
			})
			.on("GET", "/_emdash/api/bylines", { data: { items: [] } })
			.on("POST", "/_emdash/api/content/posts", {
				data: {
					item: {
						id: "new_01",
						type: "posts",
						slug: null,
						status: "draft",
						locale: "fr",
						translationGroup: null,
						data: { title: "Test Post" },
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
			});
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("passes locale=fr to the API when ?locale=fr is in the URL", async () => {
		// Bug: ContentNewPage has no validateSearch and never reads the locale param,
		// so the POST body always omits locale regardless of what is in the URL.
		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection/new",
			params: { collection: "posts" },
			search: { locale: "fr" },
		});

		const screen = await render(<TestApp />);

		// Wait for the editor to appear (manifest must have loaded)
		await expect
			.element(screen.getByRole("button", { name: "Save" }))
			.toBeInTheDocument();

		// Capture outgoing requests
		const requests: { url: string; body: unknown }[] = [];
		const origFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/content/posts") && init?.method === "POST") {
				const body = init.body ? JSON.parse(init.body as string) : null;
				requests.push({ url, body });
			}
			return origFetch(input, init);
		};

		await screen.getByRole("button", { name: "Save" }).click();

		globalThis.fetch = origFetch;

		// After the fix: the POST body must include locale: "fr"
		expect(requests).toHaveLength(1);
		expect(requests[0]!.body).toMatchObject({ locale: "fr" });
	});
});
