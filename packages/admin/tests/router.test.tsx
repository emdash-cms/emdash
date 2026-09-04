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
import { ConfigurationLoadingScreen, createAdminRouter } from "../src/router";
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
		onAuthorChange,
		onSeoChange,
		onPublishedAtChange,
		isSaving,
		isAutosaving,
		isSaveFeedbackActive,
		isUpdatingPublishedAt,
		autosaveCompletionToken,
		autosaveRejectionToken,
	}: {
		item?: { data?: { title?: string }; slug?: string | null };
		onSave?: (payload: { data: Record<string, unknown> }) => void;
		onAutosave?: (payload: { data: Record<string, unknown>; slug?: string }) => void;
		onAuthorChange?: (authorId: string | null) => void;
		onSeoChange?: (seo: { title: string }) => void;
		onPublishedAtChange?: (publishedAt: string) => void;
		isSaving?: boolean;
		isAutosaving?: boolean;
		isSaveFeedbackActive?: boolean;
		isUpdatingPublishedAt?: boolean;
		autosaveCompletionToken?: number;
		autosaveRejectionToken?: number;
	}) => (
		<div data-testid="content-editor">
			<div data-testid="mock-title">{item?.data?.title ?? ""}</div>
			<div data-testid="mock-slug">{item?.slug ?? ""}</div>
			<div data-testid="is-saving">{isSaveFeedbackActive ? "saving" : "idle"}</div>
			<div data-testid="manual-save-blocked">{isSaving ? "blocked" : "ready"}</div>
			<div data-testid="autosave-blocked">{isSaving || isAutosaving ? "blocked" : "ready"}</div>
			<div data-testid="autosave-completion-token">{autosaveCompletionToken ?? 0}</div>
			<div data-testid="autosave-rejection-token">{autosaveRejectionToken ?? 0}</div>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					onSave?.({ data: { title: "Test Post" } });
				}}
			>
				<button type="submit" disabled={isSaving}>
					Save
				</button>
			</form>
			<button
				type="button"
				disabled={isSaving || isAutosaving}
				onClick={() =>
					onAutosave?.({
						data: { title: "Autosaved Title" },
						slug: "autosaved-title",
					})
				}
			>
				Trigger Draft Sync
			</button>
			<button type="button" onClick={() => onSeoChange?.({ title: "Search title" })}>
				Trigger SEO Sync
			</button>
			<button type="button" onClick={() => onAuthorChange?.("user_02")}>
				Trigger Author Sync
			</button>
			<button
				type="button"
				disabled={isUpdatingPublishedAt}
				onClick={() => onPublishedAtChange?.("2020-06-01T08:45:00.000Z")}
			>
				Trigger Publish Date Sync
			</button>
		</div>
	),
}));

vi.mock("../src/components/MediaLibrary", () => ({
	MediaLibrary: ({
		items,
		isLoading,
		onUpload,
		onLocalSearchChange,
		folders,
		hasMoreFolders,
		onLoadMoreFolders,
		folderId,
		currentFolder,
		canManageFolders,
		onOpenFolder,
		onBackToMain,
		onCreateFolder,
		onRenameFolder,
		onDeleteFolder,
		canMoveMedia,
		onMoveMedia,
		pagination,
	}: {
		items?: Array<{ id?: string }>;
		isLoading?: boolean;
		onUpload?: (file: File) => Promise<unknown> | void;
		onLocalSearchChange?: (search: string) => void;
		folders?: Array<{ id: string }>;
		hasMoreFolders?: boolean;
		onLoadMoreFolders?: () => void;
		folderId?: string;
		currentFolder?: { id: string; name: string } | null;
		canManageFolders?: boolean;
		onOpenFolder?: (folder: { id: string; name: string }) => void;
		onBackToMain?: () => void;
		onCreateFolder?: (name: string) => Promise<unknown>;
		onRenameFolder?: (folder: { id: string; name: string }, name: string) => Promise<unknown>;
		onDeleteFolder?: (folder: { id: string; name: string }) => Promise<void>;
		canMoveMedia?: (item: { authorId: string | null }) => boolean;
		onMoveMedia?: (
			item: { id: string; authorId: string | null },
			folder: { id: string; name: string },
		) => Promise<void>;
		pagination?: {
			page: number;
			perPage: number;
			onPageChange: (page: number) => void;
			onPageSizeChange: (perPage: number) => void;
		};
	}) => {
		const [uploadStatus, setUploadStatus] = React.useState("idle");
		const [moveStatus, setMoveStatus] = React.useState("move-ready");

		const upload = async () => {
			setUploadStatus("uploading");
			try {
				await onUpload?.(new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }));
				setUploadStatus("success");
			} catch {
				setUploadStatus("error");
			}
		};
		const moveMedia = async () => {
			setMoveStatus("moving");
			try {
				await onMoveMedia?.(
					{ id: "media_01", authorId: "user_01" },
					{ id: "folder-one", name: "Folder One" },
				);
				setMoveStatus("moved");
			} catch {
				setMoveStatus("move-error");
			}
		};

		return (
			<div>
				<button type="button" onClick={() => void upload()}>
					Upload test file
				</button>
				<span>{uploadStatus}</span>
				<span data-testid="media-item-count">{items?.length ?? 0}</span>
				<span data-testid="media-first-item">{items?.[0]?.id ?? ""}</span>
				<span data-testid="media-loading">{isLoading ? "loading" : "ready"}</span>
				<span data-testid="folder-count">{folders?.length ?? 0}</span>
				<button type="button" disabled={!hasMoreFolders} onClick={onLoadMoreFolders}>
					Load more folders
				</button>
				<button type="button" onClick={() => folders?.[0] && onOpenFolder?.(folders[0])}>
					Open mock folder
				</button>
				<button type="button" onClick={onBackToMain}>
					Back to Main
				</button>
				{canManageFolders && (
					<>
						<button type="button" onClick={() => void onCreateFolder?.("Created")}>
							Create mock folder
						</button>
						<button
							type="button"
							onClick={() => currentFolder && void onRenameFolder?.(currentFolder, "Renamed")}
						>
							Rename current folder
						</button>
						<button
							type="button"
							onClick={() => currentFolder && void onDeleteFolder?.(currentFolder)}
						>
							Delete current folder
						</button>
					</>
				)}
				<span data-testid="current-folder-id">{folderId ?? "main"}</span>
				<span data-testid="can-move-own-media">
					{canMoveMedia?.({ authorId: "user_01" }) ? "yes" : "no"}
				</span>
				<span data-testid="can-move-other-media">
					{canMoveMedia?.({ authorId: "other-user" }) ? "yes" : "no"}
				</span>
				<button type="button" onClick={() => void moveMedia()}>
					Move mock media
				</button>
				<span data-testid="move-status">{moveStatus}</span>
				{pagination && (
					<>
						<span data-testid="media-page">{pagination.page}</span>
						<span data-testid="media-page-size">{pagination.perPage}</span>
						<button type="button" onClick={() => pagination.onPageChange(2)}>
							Open page 2
						</button>
						<button type="button" onClick={() => pagination.onPageSizeChange(70)}>
							Show 70 per page
						</button>
						<button type="button" onClick={() => onLocalSearchChange?.("photo")}>
							Search media
						</button>
					</>
				)}
			</div>
		);
	},
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

describe("ConfigurationLoadingScreen", () => {
	it("matches the centered EmDash boot loading view", async () => {
		const screen = await render(<ConfigurationLoadingScreen />);
		const loader = screen.getByRole("status", { name: "Loading" });
		const label = screen.getByText("Loading configuration...");
		const loadingView = label.element().parentElement?.parentElement;

		expect(loadingView).toHaveClass("emdash-configuration-loader");
		expect(loader.element().tagName).toBe("DIV");
		await expect.element(loader).toHaveClass("emdash-configuration-spinner");
		await expect.element(label).toHaveClass("emdash-configuration-label");
		expect(label.element().parentElement).toHaveClass("loader-inner");
	});
});

describe("MediaPage – upload completion", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", {
				data: { id: "user_01", role: 60 },
			})
			.on("GET", "/_emdash/api/media/folders/folder-one", {
				data: { item: { id: "folder-one", name: "Folder One" } },
			})
			.on("GET", "/_emdash/api/media/folders", {
				data: { items: [{ id: "folder-one", name: "Folder One" }] },
			})
			.on("POST", "/_emdash/api/media/folders", {
				data: { item: { id: "folder-created", name: "Created" } },
			})
			.on("PUT", "/_emdash/api/media/folders/folder-one", {
				data: { item: { id: "folder-one", name: "Renamed" } },
			})
			.on("DELETE", "/_emdash/api/media/folders/folder-one", {
				data: { deleted: true },
			})
			.on("PUT", "/_emdash/api/media/media_01", {
				data: {
					item: {
						id: "media_01",
						filename: "photo.jpg",
						mimeType: "image/jpeg",
						url: "/media/photo.jpg",
						storageKey: "photo.jpg",
						size: 1,
						createdAt: "2025-01-01T00:00:00Z",
						authorId: "user_01",
						folderId: "folder-one",
					},
				},
			})
			.on("GET", "/_emdash/api/media", {
				data: { items: [], totalCount: 60 },
			});
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("waits for the upload request and propagates its failure", async () => {
		const { router, TestApp } = buildRouter();
		await router.navigate({ to: "/media" });

		const screen = await render(<TestApp />);
		await expect.element(screen.getByText("idle")).toBeInTheDocument();

		const interceptedFetch = globalThis.fetch;
		let rejectUploadUrl: ((reason: Error) => void) | undefined;
		let markUploadUrlStarted: () => void = () => undefined;
		const uploadUrlStarted = new Promise<void>((resolve) => {
			markUploadUrlStarted = resolve;
		});
		globalThis.fetch = (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === "/_emdash/api/media/upload-url" && init?.method === "POST") {
				return new Promise<Response>((_resolve, reject) => {
					rejectUploadUrl = reject;
					markUploadUrlStarted();
				});
			}
			return interceptedFetch(input, init);
		};

		try {
			await screen.getByRole("button", { name: "Upload test file" }).click();
			await expect.element(screen.getByText("uploading")).toBeInTheDocument();

			await uploadUrlStarted;
			if (!rejectUploadUrl) throw new Error("Upload URL request was not intercepted");
			rejectUploadUrl(new Error("connection closed"));
			await expect.element(screen.getByText("error")).toBeInTheDocument();
		} finally {
			globalThis.fetch = interceptedFetch;
		}
	});

	it("persists a media folder move and refreshes media before resolving", async () => {
		const requests: Array<{ method: string; path: string }> = [];
		const mockedFetch = globalThis.fetch;
		let movePersisted = false;
		let mediaRefreshStarted = false;
		let releaseMediaRefresh: () => void = () => undefined;
		const mediaRefreshGate = new Promise<void>((resolve) => {
			releaseMediaRefresh = resolve;
		});
		globalThis.fetch = async (input, init) => {
			const rawUrl =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const path = new URL(rawUrl, "http://localhost").pathname;
			const method = init?.method ?? "GET";
			requests.push({
				method,
				path,
			});
			if (movePersisted && method === "GET" && path === "/_emdash/api/media") {
				mediaRefreshStarted = true;
				await mediaRefreshGate;
			}
			const response = await mockedFetch(input, init);
			if (method === "PUT" && path === "/_emdash/api/media/media_01") movePersisted = true;
			return response;
		};

		try {
			const { router, TestApp } = buildRouter();
			await router.navigate({ to: "/media" });
			const screen = await render(<TestApp />);
			await expect.element(screen.getByTestId("move-status")).toHaveTextContent("move-ready");
			const mediaReadsBefore = requests.filter(
				(request) => request.method === "GET" && request.path === "/_emdash/api/media",
			).length;

			await screen.getByRole("button", { name: "Move mock media" }).click();
			await vi.waitFor(() => expect(mediaRefreshStarted).toBe(true));
			expect(screen.getByTestId("move-status").element()).toHaveTextContent("moving");
			releaseMediaRefresh();
			await expect.element(screen.getByTestId("move-status")).toHaveTextContent("moved");
			expect(
				requests.some(
					(request) => request.method === "PUT" && request.path === "/_emdash/api/media/media_01",
				),
			).toBe(true);
			expect(
				requests.filter(
					(request) => request.method === "GET" && request.path === "/_emdash/api/media",
				).length,
			).toBeGreaterThan(mediaReadsBefore);
		} finally {
			releaseMediaRefresh();
			globalThis.fetch = mockedFetch;
		}
	});

	it("waits for stale media and folder recovery after a missing move target", async () => {
		const mockedFetch = globalThis.fetch;
		let recovering = false;
		let releaseRecovery: () => void = () => undefined;
		const recoveryGate = new Promise<void>((resolve) => {
			releaseRecovery = resolve;
		});
		const recoveryReads = new Set<string>();
		globalThis.fetch = async (input, init) => {
			const rawUrl =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(rawUrl, "http://localhost");
			if (url.pathname === "/_emdash/api/media/media_01" && init?.method === "PUT") {
				recovering = true;
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: "NOT_FOUND", message: "Media folder not found" },
					}),
					{ status: 404, headers: { "Content-Type": "application/json" } },
				);
			}
			if (
				recovering &&
				init?.method !== "PUT" &&
				(url.pathname === "/_emdash/api/media" ||
					url.pathname === "/_emdash/api/media/folders" ||
					url.pathname === "/_emdash/api/media/folders/folder-one")
			) {
				recoveryReads.add(url.pathname);
				await recoveryGate;
			}
			return mockedFetch(input, init);
		};

		try {
			const { router, TestApp } = buildRouter();
			await router.navigate({ to: "/media", search: { folder: "folder-one" } });
			const screen = await render(<TestApp />);
			await screen.getByRole("button", { name: "Search media" }).click();
			await screen.getByRole("button", { name: "Move mock media" }).click();
			await expect.element(screen.getByTestId("move-status")).toHaveTextContent("moving");
			await vi.waitFor(() => {
				expect(recoveryReads).toEqual(
					new Set([
						"/_emdash/api/media",
						"/_emdash/api/media/folders",
						"/_emdash/api/media/folders/folder-one",
					]),
				);
			});
			expect(screen.getByTestId("move-status").element()).toHaveTextContent("moving");
			releaseRecovery();
			await expect.element(screen.getByTestId("move-status")).toHaveTextContent("move-error");
		} finally {
			releaseRecovery();
			globalThis.fetch = mockedFetch;
		}
	});

	it("clears cached move eligibility while recovering from authorization failure", async () => {
		const mockedFetch = globalThis.fetch;
		let recovering = false;
		let releaseCurrentUser: () => void = () => undefined;
		const currentUserGate = new Promise<void>((resolve) => {
			releaseCurrentUser = resolve;
		});
		let currentUserRecoveryStarted = false;
		globalThis.fetch = async (input, init) => {
			const rawUrl =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(rawUrl, "http://localhost");
			if (url.pathname === "/_emdash/api/media/media_01" && init?.method === "PUT") {
				recovering = true;
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: "FORBIDDEN", message: "Permission denied" },
					}),
					{ status: 403, headers: { "Content-Type": "application/json" } },
				);
			}
			if (recovering && url.pathname === "/_emdash/api/auth/me") {
				currentUserRecoveryStarted = true;
				await currentUserGate;
				return new Response(
					JSON.stringify({
						success: false,
						error: { code: "INVALID_TOKEN", message: "Invalid token" },
					}),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				);
			}
			return mockedFetch(input, init);
		};

		try {
			const { router, TestApp } = buildRouter();
			await router.navigate({ to: "/media" });
			const screen = await render(<TestApp />);
			await expect.element(screen.getByTestId("can-move-own-media")).toHaveTextContent("yes");
			await screen.getByRole("button", { name: "Move mock media" }).click();
			await vi.waitFor(() => expect(currentUserRecoveryStarted).toBe(true));
			expect(screen.getByTestId("move-status").element()).toHaveTextContent("moving");
			releaseCurrentUser();
			await expect.element(screen.getByTestId("move-status")).toHaveTextContent("move-error");
			await expect.element(screen.getByTestId("can-move-own-media")).toHaveTextContent("no");
		} finally {
			releaseCurrentUser();
			globalThis.fetch = mockedFetch;
		}
	});

	it("requests numbered pages and resets page state for page size and search", async () => {
		const requests: string[] = [];
		const mockedFetch = globalThis.fetch;
		globalThis.fetch = (input, init) => {
			requests.push(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			);
			return mockedFetch(input, init);
		};

		const { router, TestApp } = buildRouter();
		await router.navigate({ to: "/media" });
		const screen = await render(<TestApp />);

		await expect.element(screen.getByTestId("media-page")).toHaveTextContent("1");
		await vi.waitFor(() => {
			expect(requests.some((url) => url.includes("/_emdash/api/media?page=1&limit=35"))).toBe(true);
		});

		await screen.getByRole("button", { name: "Open page 2" }).click();
		await expect.element(screen.getByTestId("media-page")).toHaveTextContent("2");
		await vi.waitFor(() => {
			expect(requests.some((url) => url.includes("/_emdash/api/media?page=2&limit=35"))).toBe(true);
		});

		await screen.getByRole("button", { name: "Show 70 per page" }).click();
		await expect.element(screen.getByTestId("media-page")).toHaveTextContent("1");
		await expect.element(screen.getByTestId("media-page-size")).toHaveTextContent("70");

		await screen.getByRole("button", { name: "Search media" }).click();
		await vi.waitFor(() => {
			expect(
				requests.some(
					(url) => url.includes("/_emdash/api/media?page=1&limit=70") && url.includes("q=photo"),
				),
			).toBe(true);
		});
	});

	it("maps root and direct folder URL state to media filters with global search precedence", async () => {
		const requests: string[] = [];
		const mockedFetch = globalThis.fetch;
		globalThis.fetch = (input, init) => {
			requests.push(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			);
			return mockedFetch(input, init);
		};

		const { router, TestApp } = buildRouter();
		await router.navigate({ to: "/media" });
		const screen = await render(<TestApp />);

		await vi.waitFor(() => {
			expect(
				requests.some(
					(url) =>
						url.includes("/_emdash/api/media?") &&
						new URL(url, "http://localhost").searchParams.get("folderId") === "unfiled",
				),
			).toBe(true);
		});

		await router.navigate({ to: "/media", search: { folder: "folder-one" } });
		await vi.waitFor(() => {
			expect(requests.some((url) => url.includes("/media/folders/folder-one"))).toBe(true);
			expect(
				requests.some(
					(url) => new URL(url, "http://localhost").searchParams.get("folderId") === "folder-one",
				),
			).toBe(true);
		});

		await screen.getByRole("button", { name: "Search media" }).click();
		await vi.waitFor(() => {
			expect(
				requests.some((rawUrl) => {
					const url = new URL(rawUrl, "http://localhost");
					return url.searchParams.get("q") === "photo" && !url.searchParams.has("folderId");
				}),
			).toBe(true);
		});
	});

	it("does not request the previous page when direct folder state changes", async () => {
		const requests: string[] = [];
		const mockedFetch = globalThis.fetch;
		globalThis.fetch = (input, init) => {
			requests.push(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			);
			return mockedFetch(input, init);
		};

		const { router, TestApp } = buildRouter();
		await router.navigate({ to: "/media" });
		const screen = await render(<TestApp />);
		await screen.getByRole("button", { name: "Open page 2" }).click();
		await expect.element(screen.getByTestId("media-page")).toHaveTextContent("2");

		requests.length = 0;
		await router.navigate({ to: "/media", search: { folder: "folder-one" } });
		await vi.waitFor(() => {
			expect(
				requests.some((rawUrl) => {
					const url = new URL(rawUrl, "http://localhost");
					return (
						url.searchParams.get("folderId") === "folder-one" &&
						url.searchParams.get("page") === "1"
					);
				}),
			).toBe(true);
		});
		expect(
			requests.some((rawUrl) => {
				const url = new URL(rawUrl, "http://localhost");
				return (
					url.searchParams.get("folderId") === "folder-one" && url.searchParams.get("page") === "2"
				);
			}),
		).toBe(false);
	});

	it("loads bounded folder pages and exposes explicit load-more state", async () => {
		const mockedFetch = globalThis.fetch;
		const folderRequests: URL[] = [];
		globalThis.fetch = (input, init) => {
			const rawUrl =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(rawUrl, "http://localhost");
			if (url.pathname === "/_emdash/api/media/folders") {
				folderRequests.push(url);
				const cursor = url.searchParams.get("cursor");
				return Promise.resolve(
					Response.json({
						data:
							cursor === "next-folder"
								? { items: [{ id: "folder-two", name: "Folder Two" }] }
								: {
										items: [{ id: "folder-one", name: "Folder One" }],
										nextCursor: "next-folder",
									},
					}),
				);
			}
			return mockedFetch(input, init);
		};

		const { router, TestApp } = buildRouter();
		await router.navigate({ to: "/media" });
		const screen = await render(<TestApp />);

		await expect.element(screen.getByTestId("folder-count")).toHaveTextContent("1");
		await screen.getByRole("button", { name: "Load more folders" }).click();
		await expect.element(screen.getByTestId("folder-count")).toHaveTextContent("2");
		expect(folderRequests).toHaveLength(2);
		expect(folderRequests[0]?.searchParams.get("limit")).toBe("100");
		expect(folderRequests[1]?.searchParams.get("cursor")).toBe("next-folder");
	});

	it("orchestrates create, open, rename, and current-folder delete", async () => {
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		const mockedFetch = globalThis.fetch;
		globalThis.fetch = (input, init) => {
			calls.push({
				url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			return mockedFetch(input, init);
		};

		const { router, TestApp } = buildRouter();
		await router.navigate({ to: "/media" });
		const navigateSpy = vi.spyOn(router, "navigate");
		const screen = await render(<TestApp />);
		await expect.element(screen.getByTestId("folder-count")).toHaveTextContent("1");

		await screen.getByRole("button", { name: "Create mock folder" }).click();
		await vi.waitFor(() => {
			const request = calls.find((call) => call.method === "POST" && call.url.endsWith("/folders"));
			expect(request?.body && JSON.parse(request.body)).toEqual({ name: "Created" });
		});

		await screen.getByRole("button", { name: "Open mock folder" }).click();
		await vi.waitFor(() => {
			expect(router.state.location.search).toEqual({ folder: "folder-one" });
			expect(screen.getByTestId("current-folder-id").element()).toHaveTextContent("folder-one");
			expect(navigateSpy).toHaveBeenCalledWith(expect.objectContaining({ resetScroll: false }));
		});

		await screen.getByRole("button", { name: "Back to Main" }).click();
		await vi.waitFor(() => {
			expect(router.state.location.search).toEqual({});
			expect(navigateSpy).toHaveBeenCalledWith(
				expect.objectContaining({ search: { folder: undefined }, resetScroll: false }),
			);
		});
		await screen.getByRole("button", { name: "Open mock folder" }).click();

		await screen.getByRole("button", { name: "Rename current folder" }).click();
		await vi.waitFor(() => {
			const request = calls.find(
				(call) => call.method === "PUT" && call.url.endsWith("/folders/folder-one"),
			);
			expect(request?.body && JSON.parse(request.body)).toEqual({ name: "Renamed" });
		});

		await screen.getByRole("button", { name: "Delete current folder" }).click();
		await vi.waitFor(() => {
			expect(
				calls.some((call) => call.method === "DELETE" && call.url.endsWith("/folders/folder-one")),
			).toBe(true);
			expect(router.state.location.search).toEqual({});
			expect(navigateSpy).toHaveBeenCalledWith(
				expect.objectContaining({ replace: true, resetScroll: false }),
			);
		});
	});

	it("allows authors to move their own media but not another user's media", async () => {
		mockFetch.on("GET", "/_emdash/api/auth/me", {
			data: { id: "user_01", role: 30 },
		});
		const { router, TestApp } = buildRouter();
		await router.navigate({ to: "/media" });
		const screen = await render(<TestApp />);

		await expect.element(screen.getByTestId("can-move-own-media")).toHaveTextContent("yes");
		await expect.element(screen.getByTestId("can-move-other-media")).toHaveTextContent("no");
	});

	it("replaces a missing direct folder URL with Main library once", async () => {
		mockFetch.on(
			"GET",
			"/_emdash/api/media/folders/missing-folder",
			{ error: { code: "NOT_FOUND", message: "Media folder not found" } },
			404,
		);
		const requests: string[] = [];
		const mockedFetch = globalThis.fetch;
		globalThis.fetch = (input, init) => {
			requests.push(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			);
			return mockedFetch(input, init);
		};

		const { router, TestApp } = buildRouter();
		await router.navigate({ to: "/media", search: { folder: "missing-folder" } });
		const screen = await render(<TestApp />);

		await vi.waitFor(() => {
			expect(router.state.location.search).toEqual({});
			expect(
				requests.some(
					(rawUrl) =>
						new URL(rawUrl, "http://localhost").searchParams.get("folderId") === "unfiled",
				),
			).toBe(true);
		});
		await expect.element(screen.getByText("Folder no longer exists")).toBeInTheDocument();
	});

	it("recovers an emptied later page without exposing an invalid page number", async () => {
		const mockedFetch = globalThis.fetch;
		let requestedSecondPage = false;
		globalThis.fetch = (input, init) => {
			const rawUrl =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(rawUrl, "http://localhost");
			if (url.pathname === "/_emdash/api/media") {
				const requestedPage = url.searchParams.get("page");
				if (requestedPage === "2") {
					requestedSecondPage = true;
					return Promise.resolve(
						new Response(JSON.stringify({ data: { items: [], totalCount: 0 } }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				const totalCount = requestedSecondPage ? 0 : 60;
				return Promise.resolve(
					new Response(JSON.stringify({ data: { items: [], totalCount } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return mockedFetch(input, init);
		};

		const { router, TestApp } = buildRouter();
		await router.navigate({ to: "/media" });
		const screen = await render(<TestApp />);
		await expect.element(screen.getByTestId("media-page")).toHaveTextContent("1");

		await screen.getByRole("button", { name: "Open page 2" }).click();

		await vi.waitFor(() => {
			expect(requestedSecondPage).toBe(true);
			expect(screen.getByTestId("media-page").element()).toHaveTextContent("1");
		});
	});

	it("keeps the current page rendered while the next page loads", async () => {
		const mockedFetch = globalThis.fetch;
		let resolveSecondPage: ((response: Response) => void) | undefined;
		globalThis.fetch = (input, init) => {
			const rawUrl =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(rawUrl, "http://localhost");
			if (url.pathname === "/_emdash/api/media") {
				if (url.searchParams.get("page") === "2") {
					return new Promise<Response>((resolve) => {
						resolveSecondPage = resolve;
					});
				}
				return Promise.resolve(
					new Response(JSON.stringify({ data: { items: [{ id: "page-1" }], totalCount: 60 } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return mockedFetch(input, init);
		};

		const { router, TestApp } = buildRouter();
		await router.navigate({ to: "/media" });
		const screen = await render(<TestApp />);
		await expect.element(screen.getByTestId("media-item-count")).toHaveTextContent("1");
		await expect.element(screen.getByTestId("media-first-item")).toHaveTextContent("page-1");

		await screen.getByRole("button", { name: "Open page 2" }).click();
		await vi.waitFor(() => expect(resolveSecondPage).toBeTypeOf("function"));

		await expect.element(screen.getByTestId("media-item-count")).toHaveTextContent("1");
		await expect.element(screen.getByTestId("media-first-item")).toHaveTextContent("page-1");
		await expect.element(screen.getByTestId("media-loading")).toHaveTextContent("loading");

		resolveSecondPage?.(
			new Response(JSON.stringify({ data: { items: [{ id: "page-2" }], totalCount: 60 } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		await expect.element(screen.getByTestId("media-loading")).toHaveTextContent("ready");
		await expect.element(screen.getByTestId("media-first-item")).toHaveTextContent("page-2");
	});
});

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
// Tests: ContentListPage – hook order stays stable across an erroring refetch
// (regression for #1415: inline useCallback for onLoadMore sat below the early
// returns, so a render that took the `error` guard ran one fewer hook → React
// #300 "Rendered fewer hooks than expected").
// ---------------------------------------------------------------------------

describe("ContentListPage – hook order is stable when a refetch errors (#1415)", () => {
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

	it("renders the ErrorScreen instead of crashing when a content refetch fails", async () => {
		const { router, queryClient, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection",
			params: { collection: "posts" },
		});

		const screen = await render(<TestApp />);

		// First render succeeds and reaches the inline onLoadMore useCallback.
		const addNewLink = screen.getByRole("link", { name: /add new/i });
		await expect.element(addNewLink).toBeInTheDocument();

		// Make the next content fetch fail, then force a refetch. The component
		// re-renders with `error` truthy and takes the ErrorScreen early return,
		// which sits ABOVE the onLoadMore useCallback. If that callback hook is
		// below the guards, this render runs one fewer hook and React throws #300
		// — so the ErrorScreen (and its Retry button) never appears.
		mockFetch.on("GET", "/_emdash/api/content/posts", { error: { message: "Boom" } }, 500);
		await queryClient.refetchQueries({ queryKey: ["content", "posts"] });

		const retryButton = screen.getByRole("button", { name: /retry/i });
		await expect.element(retryButton).toBeInTheDocument();
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
		await expect
			.element(screen.getByRole("button", { name: "Save", exact: true }))
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

		await screen.getByRole("button", { name: "Save", exact: true }).click();

		globalThis.fetch = origFetch;

		// After the fix: the POST body must include locale: "de"
		expect(requests).toHaveLength(1);
		expect(requests[0]!.body).toMatchObject({ locale: "de" });
	});
});

// ---------------------------------------------------------------------------
// Tests: ContentNewPage – a rejected create surfaces an error toast
// ---------------------------------------------------------------------------

describe("ContentNewPage – create failure surfaces the server's error", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();

		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", {
				data: { id: "user_01", role: 60 },
			})
			.on("GET", "/_emdash/api/bylines", { data: { items: [] } })
			// A canned 409 SLUG_CONFLICT — the response shape the server
			// returns when the entry's slug is already taken in the
			// collection (slug derivation itself is server-side and not
			// exercised here).
			.on(
				"POST",
				"/_emdash/api/content/posts",
				{
					success: false,
					error: {
						code: "SLUG_CONFLICT",
						message: "Slug 'test-post' already exists in collection 'posts'",
					},
				},
				409,
			);
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("shows a toast with the server's message on a slug conflict (and stays on /new)", async () => {
		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection/new",
			params: { collection: "posts" },
			search: { locale: undefined },
		});

		const screen = await render(<TestApp />);

		await expect
			.element(screen.getByRole("button", { name: "Save", exact: true }))
			.toBeInTheDocument();

		await screen.getByRole("button", { name: "Save", exact: true }).click();

		// The UI surfaces WHAT happened — the server's human-readable
		// conflict message.
		await expect.element(screen.getByText("Failed to save")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Slug 'test-post' already exists in collection 'posts'"))
			.toBeInTheDocument();

		// And with the error affordance: Kumo styles severity off `variant`
		// (Base UI's `type` is inert for styling), and the toast icon only
		// renders for a non-default variant.
		await expect
			.poll(() => document.querySelectorAll("[data-toast-icon]").length)
			.toBeGreaterThan(0);

		// And the failed create must not navigate anywhere.
		expect(router.state.location.pathname).toContain("/content/posts/new");
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
					_rev: "revision-token",
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
			.on("GET", "/_emdash/api/content/posts/post_2", {
				data: {
					item: {
						id: "post_2",
						type: "posts",
						slug: "second-post",
						status: "draft",
						locale: "en",
						translationGroup: null,
						data: { title: "Second Post" },
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

		await screen.getByRole("button", { name: "Trigger Draft Sync" }).click();

		await waitFor(() => {
			expect(screen.getByTestId("mock-title").element().textContent).toBe("Autosaved Title");
			expect(screen.getByTestId("mock-slug").element().textContent).toBe("autosaved-title");
		});
	});

	it("echoes the current revision token in editor and auxiliary writes", async () => {
		const { router, TestApp } = buildRouter();

		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});

		const screen = await render(<TestApp />);
		await waitFor(() => {
			expect(screen.getByTestId("mock-title").element().textContent).toBe("Draft Title");
		});

		const fetchWithMocks = globalThis.fetch;
		const putBodies: Record<string, unknown>[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (init?.method === "PUT" && url.includes("/content/posts/post_1")) {
				if (typeof init.body !== "string") throw new TypeError("Expected a JSON request body");
				putBodies.push(JSON.parse(init.body) as Record<string, unknown>);
			}
			return fetchWithMocks(input, init);
		}) as typeof fetch;

		try {
			await screen.getByRole("button", { name: "Save", exact: true }).click();
			await waitFor(() => expect(putBodies).toHaveLength(1));

			await screen.getByRole("button", { name: "Trigger Draft Sync" }).click();
			await waitFor(() => expect(putBodies).toHaveLength(2));

			await screen.getByRole("button", { name: "Trigger Author Sync" }).click();
			await waitFor(() => expect(putBodies).toHaveLength(3));

			await screen.getByRole("button", { name: "Trigger SEO Sync" }).click();
			await waitFor(() => expect(putBodies).toHaveLength(4));

			expect(putBodies).toEqual([
				{ data: { title: "Test Post" }, _rev: "revision-token" },
				{
					data: { title: "Autosaved Title" },
					slug: "autosaved-title",
					_rev: "revision-token",
					skipRevision: true,
				},
				{ authorId: "user_02", _rev: "revision-token" },
				{ seo: { title: "Search title" }, _rev: "revision-token" },
			]);
		} finally {
			globalThis.fetch = fetchWithMocks;
		}
	});

	it("sends publish-date changes through the auxiliary update payload", async () => {
		const fetchWithMocks = globalThis.fetch;
		let updateBody: Record<string, unknown> | undefined;
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (init?.method === "PUT" && url.includes("/content/posts/post_1")) {
				if (typeof init.body !== "string") throw new TypeError("Expected a JSON request body");
				updateBody = JSON.parse(init.body) as Record<string, unknown>;
			}
			return fetchWithMocks(input, init);
		}) as typeof fetch;

		try {
			const { router, TestApp } = buildRouter();
			await router.navigate({
				to: "/content/$collection/$id",
				params: { collection: "posts", id: "post_1" },
			});
			const screen = await render(<TestApp />);
			await waitFor(() => {
				expect(screen.getByTestId("mock-title").element().textContent).toBe("Draft Title");
			});

			await screen.getByRole("button", { name: "Trigger Publish Date Sync" }).click();

			await waitFor(() => {
				expect(updateBody).toEqual({ publishedAt: "2020-06-01T08:45:00.000Z" });
			});
		} finally {
			globalThis.fetch = fetchWithMocks;
		}
	});

	it("keeps publish-date editing disabled while its update remains pending", async () => {
		const fetchWithMocks = globalThis.fetch;
		let releasePublishedAt: (() => void) | undefined;
		let seoRequestSeen = false;
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (init?.method !== "PUT" || !url.includes("/content/posts/post_1")) {
				return fetchWithMocks(input, init);
			}
			if (typeof init.body !== "string") throw new TypeError("Expected a JSON request body");
			const body = JSON.parse(init.body) as Record<string, unknown>;
			const response = fetchWithMocks(input, init);
			if (body.publishedAt !== undefined) {
				return new Promise<Response>((resolve) => {
					releasePublishedAt = () => void response.then(resolve);
				});
			}
			seoRequestSeen = body.seo !== undefined;
			return response;
		}) as typeof fetch;

		try {
			const { router, TestApp } = buildRouter();
			await router.navigate({
				to: "/content/$collection/$id",
				params: { collection: "posts", id: "post_1" },
			});
			const screen = await render(<TestApp />);
			await waitFor(() => {
				expect(screen.getByTestId("mock-title").element().textContent).toBe("Draft Title");
			});

			const publishDateButton = screen.getByRole("button", {
				name: "Trigger Publish Date Sync",
			});
			await publishDateButton.click();
			await expect.element(publishDateButton).toBeDisabled();

			await screen.getByRole("button", { name: "Trigger SEO Sync" }).click();
			await waitFor(() => {
				expect(seoRequestSeen).toBe(true);
			});
			await expect.element(publishDateButton).toBeDisabled();
		} finally {
			releasePublishedAt?.();
			globalThis.fetch = fetchWithMocks;
		}
	});

	it("does not report auxiliary writes as saving; editor saves still do", async () => {
		const { router, TestApp } = buildRouter();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});
		const screen = await render(<TestApp />);
		await waitFor(() => {
			expect(screen.getByTestId("mock-title").element().textContent).toBe("Draft Title");
		});

		// Hold every PUT open so the mutation's pending window is observable.
		const fetchWithMocks = globalThis.fetch;
		let resolvePut: (() => void) | undefined;
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (init?.method === "PUT" && url.includes("/content/posts/post_1")) {
				return new Promise<Response>((resolve) => {
					resolvePut = () =>
						resolve(
							new Response(
								JSON.stringify({
									data: {
										item: {
											id: "post_1",
											type: "posts",
											slug: "published-slug",
											status: "draft",
											locale: "en",
											data: { title: "Published Title" },
											updatedAt: "2025-01-02T00:00:00Z",
											draftRevisionId: "rev_draft",
										},
									},
								}),
								{ status: 200, headers: { "Content-Type": "application/json" } },
							),
						);
				});
			}
			return fetchWithMocks(input, init);
		}) as typeof fetch;

		try {
			// Auxiliary write (SEO): the Save control must stay idle while it flies.
			await screen.getByRole("button", { name: "Trigger SEO Sync" }).click();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(screen.getByTestId("is-saving").element().textContent).toBe("idle");
			expect(screen.getByTestId("manual-save-blocked").element().textContent).toBe("blocked");
			await expect
				.element(screen.getByRole("button", { name: "Save", exact: true }))
				.toBeDisabled();
			resolvePut?.();
			resolvePut = undefined;
			await waitFor(() => {
				expect(screen.getByTestId("manual-save-blocked").element().textContent).toBe("ready");
			});

			// Editor save: the same mutation with source "editor" must report saving.
			await screen.getByRole("button", { name: "Save", exact: true }).click();
			await waitFor(() => {
				expect(screen.getByTestId("is-saving").element().textContent).toBe("saving");
				expect(screen.getByTestId("manual-save-blocked").element().textContent).toBe("blocked");
			});
			resolvePut?.();
			await waitFor(() => {
				expect(screen.getByTestId("is-saving").element().textContent).toBe("idle");
			});
		} finally {
			globalThis.fetch = fetchWithMocks;
		}
	});

	it("keeps editor save feedback visual without strengthening main's operation gating", async () => {
		const { router, TestApp } = buildRouter();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});
		const screen = await render(<TestApp />);
		await waitFor(() => {
			expect(screen.getByTestId("mock-title").element().textContent).toBe("Draft Title");
		});

		const fetchWithMocks = globalThis.fetch;
		const resolvers: (() => void)[] = [];
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (init?.method === "PUT" && url.includes("/content/posts/post_1")) {
				return new Promise<Response>((resolve) => {
					resolvers.push(() =>
						resolve(
							new Response(
								JSON.stringify({
									data: {
										item: {
											id: "post_1",
											type: "posts",
											slug: "published-slug",
											status: "draft",
											locale: "en",
											data: { title: "Published Title" },
											updatedAt: "2025-01-02T00:00:00Z",
											draftRevisionId: "rev_draft",
										},
									},
								}),
								{ status: 200, headers: { "Content-Type": "application/json" } },
							),
						),
					);
				});
			}
			return fetchWithMocks(input, init);
		}) as typeof fetch;

		try {
			await screen.getByRole("button", { name: "Save", exact: true }).click();
			await waitFor(() => {
				expect(screen.getByTestId("is-saving").element().textContent).toBe("saving");
			});

			// Auxiliary write lands while the editor save is still in flight.
			await screen.getByRole("button", { name: "Trigger SEO Sync" }).click();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(screen.getByTestId("is-saving").element().textContent).toBe("saving");

			// Main's shared mutation observer follows the latest auxiliary write.
			// When it settles, operation gating becomes idle even though the older
			// editor request is still running; feedback remains visual-only.
			expect(resolvers).toHaveLength(2);
			resolvers[1]?.();
			await waitFor(() => {
				expect(screen.getByTestId("manual-save-blocked").element().textContent).toBe("ready");
			});
			expect(screen.getByTestId("is-saving").element().textContent).toBe("saving");
			await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

			resolvers[0]?.();
			await waitFor(() => {
				expect(screen.getByTestId("is-saving").element().textContent).toBe("idle");
			});
		} finally {
			globalThis.fetch = fetchWithMocks;
		}
	});

	it("does not deliver an old entry's autosave completion to the current entry", async () => {
		const { router, TestApp } = buildRouter();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});
		const screen = await render(<TestApp />);
		await waitFor(() => {
			expect(screen.getByTestId("mock-title").element().textContent).toBe("Draft Title");
		});

		const fetchWithMocks = globalThis.fetch;
		let resolveFirstAutosave: (() => void) | undefined;
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (init?.method === "PUT" && url.includes("/content/posts/post_1")) {
				return new Promise<Response>((resolve) => {
					resolveFirstAutosave = () =>
						resolve(
							new Response(
								JSON.stringify({
									data: {
										item: {
											id: "post_1",
											type: "posts",
											slug: "autosaved-title",
											status: "draft",
											locale: "en",
											data: { title: "Autosaved Title" },
											updatedAt: "2025-01-02T00:00:00Z",
											draftRevisionId: "rev_draft",
										},
									},
								}),
								{ status: 200, headers: { "Content-Type": "application/json" } },
							),
						);
				});
			}
			return fetchWithMocks(input, init);
		}) as typeof fetch;

		try {
			await screen.getByRole("button", { name: "Trigger Draft Sync" }).click();
			await router.navigate({
				to: "/content/$collection/$id",
				params: { collection: "posts", id: "post_2" },
			});
			await waitFor(() => {
				expect(screen.getByTestId("mock-title").element().textContent).toBe("Second Post");
			});
			expect(screen.getByTestId("manual-save-blocked").element().textContent).toBe("ready");
			expect(screen.getByTestId("autosave-blocked").element().textContent).toBe("blocked");
			await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

			resolveFirstAutosave?.();
			await waitFor(() => {
				expect(screen.getByTestId("autosave-blocked").element().textContent).toBe("ready");
			});

			expect(screen.getByTestId("autosave-completion-token").element().textContent).toBe("0");
		} finally {
			globalThis.fetch = fetchWithMocks;
		}
	});

	it("signals a rejected autosave to the editor", async () => {
		mockFetch.on(
			"PUT",
			"/_emdash/api/content/posts/post_1?locale=en",
			{ error: { code: "VALIDATION_ERROR", message: "title: Too big" } },
			400,
		);
		const { router, TestApp } = buildRouter();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});
		const screen = await render(<TestApp />);
		await waitFor(() => {
			expect(screen.getByTestId("mock-title").element().textContent).toBe("Draft Title");
		});

		await screen.getByRole("button", { name: "Trigger Draft Sync" }).click();

		await waitFor(() => {
			expect(screen.getByTestId("autosave-rejection-token").element().textContent).toBe("1");
		});
		expect(screen.getByTestId("autosave-completion-token").element().textContent).toBe("0");
		expect(screen.getByTestId("mock-title").element().textContent).toBe("Draft Title");
	});

	it("does not signal a rejection for a server error", async () => {
		mockFetch.on(
			"PUT",
			"/_emdash/api/content/posts/post_1?locale=en",
			{ error: { code: "INTERNAL_ERROR", message: "boom" } },
			500,
		);
		const { router, TestApp } = buildRouter();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});
		const screen = await render(<TestApp />);
		await waitFor(() => {
			expect(screen.getByTestId("mock-title").element().textContent).toBe("Draft Title");
		});

		await screen.getByRole("button", { name: "Trigger Draft Sync" }).click();

		await expect.element(screen.getByText("Autosave failed")).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByTestId("autosave-blocked").element().textContent).toBe("ready");
		});
		expect(screen.getByTestId("autosave-rejection-token").element().textContent).toBe("0");
	});
});
