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

import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient, createMockFetch, waitFor } from "./utils/test-helpers";

// ---------------------------------------------------------------------------
// Component mocks – keep layout plumbing out of these tests
// ---------------------------------------------------------------------------

vi.mock("../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

vi.mock("../src/components/AdminCommandPalette", () => ({
	AdminCommandPalette: () => null,
}));

vi.mock("../src/components/ContentEditor", () => ({
	ContentEditor: ({
		item,
		onSave,
		onAutosave,
	}: {
		item?: { data?: { title?: string }; slug?: string | null };
		onSave?: (payload: { data: Record<string, unknown> }) => void;
		onAutosave?: (payload: { data: Record<string, unknown>; slug?: string }) => void;
	}) => (
		<div data-testid="content-editor">
			<div data-testid="mock-title">{item?.data?.title ?? ""}</div>
			<div data-testid="mock-slug">{item?.slug ?? ""}</div>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					onSave?.({ data: { title: "Test Post" } });
				}}
			>
				<button type="submit">Save</button>
			</form>
			<button
				type="button"
				onClick={() =>
					onAutosave?.({
						data: { title: "Autosaved Title" },
						slug: "autosaved-title",
					})
				}
			>
				Autosave
			</button>
		</div>
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
	taxonomies: [],
	i18n: {
		defaultLocale: "fr",
		locales: ["fr", "en", "de"],
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRouter() {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) {
		i18n.loadAndActivate({ locale: "en", messages: {} });
	}
	// Toasty and I18nProvider are provided by App.tsx in production.
	// Mirror that here so useLingui() and Toast.useToastManager() work inside page components.
	function TestApp() {
		return (
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>
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

	it("Add New link includes the active locale when a non-default locale (de) is selected", async () => {
		// Navigate to the content list with locale=de selected in the switcher.
		// The default locale is fr, so de is a non-default locale.
		// The "Add New" <Link> must carry ?locale=de so that ContentNewPage
		// receives it and creates content in German, not the default French.
		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection",
			params: { collection: "posts" },
			search: { locale: "de" },
		});

		const screen = await render(<TestApp />);

		const addNewLink = screen.getByRole("link", { name: /add new/i });
		await expect.element(addNewLink).toBeInTheDocument();

		const href = addNewLink.element().getAttribute("href") ?? "";
		expect(href).toContain("locale=de");
	});

	it("Add New link uses the default locale (fr) when no locale is set in the URL", async () => {
		// Navigate to the content list without an explicit locale param.
		// activeLocale falls back to the configured defaultLocale ("fr").
		// The "Add New" <Link> must carry ?locale=fr so that ContentNewPage
		// creates content in the correct default language.
		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection",
			params: { collection: "posts" },
		});

		const screen = await render(<TestApp />);

		const addNewLink = screen.getByRole("link", { name: /add new/i });
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

		const addNewLink = screen.getByRole("link", { name: /add new/i });
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
						locale: "de",
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

	it("passes locale=de to the API when ?locale=de is in the URL", async () => {
		// The default locale is fr; navigating with ?locale=de tests that the
		// non-default locale is read from search params and forwarded to createContent.
		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection/new",
			params: { collection: "posts" },
			search: { locale: "de" },
		});

		const screen = await render(<TestApp />);

		// Wait for the editor to appear (manifest must have loaded)
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

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

		// After the fix: the POST body must include locale: "de"
		expect(requests).toHaveLength(1);
		expect(requests[0]!.body).toMatchObject({ locale: "de" });
	});
});

// ---------------------------------------------------------------------------
// Tests: ContentEditPage – autosave cache stays in sync
// ---------------------------------------------------------------------------

describe("ContentEditPage – autosave cache patching", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();

		const manifestWithRevisions: AdminManifest = {
			...MANIFEST,
			i18n: undefined,
			collections: {
				posts: {
					...MANIFEST.collections.posts,
					supports: ["drafts", "revisions"],
				},
			},
		};

		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: manifestWithRevisions })
			.on("GET", "/_emdash/api/auth/me", {
				data: { id: "user_01", role: 30 },
			})
			.on("GET", "/_emdash/api/bylines", { data: { items: [] } })
			.on("GET", "/_emdash/api/content/posts/post_1", {
				data: {
					item: {
						id: "post_1",
						type: "posts",
						slug: "published-slug",
						status: "draft",
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
					},
				},
			})
			.on("GET", "/_emdash/api/revisions/rev_draft", {
				data: {
					item: {
						id: "rev_draft",
						collection: "posts",
						entryId: "post_1",
						data: { title: "Draft Title", _slug: "draft-slug" },
						authorId: null,
						createdAt: "2025-01-01T00:00:00Z",
					},
				},
			})
			.on("PUT", "/_emdash/api/content/posts/post_1", {
				data: {
					item: {
						id: "post_1",
						type: "posts",
						slug: "published-slug",
						status: "draft",
						locale: "en",
						translationGroup: null,
						data: { title: "Published Title" },
						authorId: null,
						primaryBylineId: null,
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-02T00:00:00Z",
						publishedAt: "2025-01-01T00:00:00Z",
						scheduledAt: null,
						liveRevisionId: "rev_live",
						draftRevisionId: "rev_draft",
					},
				},
			});
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("keeps the edited draft title and slug after autosave completes", async () => {
		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});

		const screen = await render(<TestApp />);

		await waitFor(() => {
			expect(screen.getByTestId("mock-title").element().textContent).toBe("Draft Title");
			expect(screen.getByTestId("mock-slug").element().textContent).toBe("draft-slug");
		});

		await screen.getByRole("button", { name: "Autosave" }).click();

		await waitFor(() => {
			expect(screen.getByTestId("mock-title").element().textContent).toBe("Autosaved Title");
			expect(screen.getByTestId("mock-slug").element().textContent).toBe("autosaved-title");
		});
	});
});
