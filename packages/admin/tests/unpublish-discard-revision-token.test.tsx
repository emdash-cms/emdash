import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { fireEvent } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "vitest-browser-react";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest, ContentItem } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "token-race",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
			hasSeo: false,
			fields: {
				title: { kind: "string", label: "Title" },
				website: { kind: "url", label: "Website" },
			},
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

type RevisionedContentItem = ContentItem & { _rev: string };

function makeItem(overrides: Partial<RevisionedContentItem> = {}): RevisionedContentItem {
	return {
		id: "post_1",
		type: "posts",
		slug: "post-one",
		status: "published",
		locale: "en",
		translationGroup: null,
		data: { title: "Live title", website: "" },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		publishedAt: "2026-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: "revision-live",
		draftRevisionId: "revision-live",
		_rev: "rev-initial",
		...overrides,
	};
}

interface RecordedRequest {
	method: string;
	url: string;
	body: Record<string, unknown> | undefined;
}

interface MockServerOptions {
	initialStatus?: string;
	initialDraftRevisionId?: string | null;
	onPut?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
	onUnpublish?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
	onDiscardDraft?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
	onRestoreRevision?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function contentResponse(item: RevisionedContentItem) {
	const { _rev, ...contentItem } = item;
	return jsonResponse({ data: { item: contentItem, _rev } });
}

function createMockServer(options: MockServerOptions = {}) {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let contentGetCount = 0;
	let putCount = 0;
	let unpublishCount = 0;
	let discardCount = 0;
	let restoreCount = 0;
	let currentRevision = "rev-initial";
	let currentStatus = options.initialStatus ?? "published";
	let currentDraftRevisionId: string | null = options.initialDraftRevisionId ?? "revision-live";
	let currentLiveRevisionId: string | null = "revision-live";

	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const request = { method, url, body };
		requests.push(request);

		if (method === "GET" && url === "/_emdash/api/manifest") {
			return jsonResponse({ data: MANIFEST });
		}
		if (method === "GET" && url === "/_emdash/api/auth/me") {
			return jsonResponse({ data: { id: "user_1", role: 40 } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/bylines")) {
			return jsonResponse({ data: { items: [] } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/users")) {
			return jsonResponse({ data: { items: [] } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			const index = contentGetCount++;
			if (index > 0) {
				// After mutating actions, reflect the latest saved data in the
				// content table so the editor doesn't refetch stale state back in.
				const savedData = requests.findLast(
					(candidate) => candidate.method === "PUT" && candidate.body?.data,
				)?.body?.data as Record<string, unknown> | undefined;
				return contentResponse(
					makeItem({
						_rev: currentRevision,
						status: currentStatus,
						liveRevisionId: currentLiveRevisionId,
						draftRevisionId: currentDraftRevisionId,
						data: savedData ?? makeItem().data,
					}),
				);
			}
			return contentResponse(
				makeItem({
					status: currentStatus,
					liveRevisionId: currentLiveRevisionId,
					draftRevisionId: currentDraftRevisionId,
				}),
			);
		}
		if (method === "GET" && url === "/_emdash/api/revisions/revision-draft") {
			const savedData = requests.findLast(
				(candidate) => candidate.method === "PUT" && candidate.body?.data,
			)?.body?.data as Record<string, unknown> | undefined;
			return jsonResponse({
				data: {
					item: {
						id: "revision-draft",
						collection: "posts",
						entryId: "post_1",
						data: savedData ?? { title: "Draft title", website: "" },
						authorId: null,
						createdAt: "2026-01-02T00:00:00Z",
					},
				},
			});
		}
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1/revisions")) {
			return jsonResponse({
				data: {
					items: [
						{
							id: "revision-draft",
							collection: "posts",
							entryId: "post_1",
							data: { title: "Draft title", website: "" },
							authorId: null,
							createdAt: "2026-01-02T00:00:00Z",
						},
						{
							id: "revision-old",
							collection: "posts",
							entryId: "post_1",
							data: { title: "Old title", website: "" },
							authorId: null,
							createdAt: "2026-01-01T00:00:00Z",
						},
					],
					total: 2,
				},
			});
		}
		if (method === "PUT" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			const index = putCount++;
			if (options.onPut) return options.onPut(request, index);
			currentRevision = `rev-save-${index + 1}`;
			currentDraftRevisionId = `revision-save-${index + 1}`;
			return contentResponse(
				makeItem({
					_rev: currentRevision,
					status: currentStatus,
					liveRevisionId: currentLiveRevisionId,
					draftRevisionId: currentDraftRevisionId,
					data: (request.body?.data as Record<string, unknown> | undefined) ?? makeItem().data,
				}),
			);
		}
		if (method === "POST" && url.startsWith("/_emdash/api/content/posts/post_1/unpublish")) {
			const index = unpublishCount++;
			if (options.onUnpublish) return options.onUnpublish(request, index);
			currentRevision = `rev-unpublish-${index + 1}`;
			currentStatus = "draft";
			currentLiveRevisionId = null;
			if (!currentDraftRevisionId) {
				currentDraftRevisionId = "revision-unpublish-draft";
			}
			return contentResponse(
				makeItem({
					_rev: currentRevision,
					status: currentStatus,
					liveRevisionId: currentLiveRevisionId,
					draftRevisionId: currentDraftRevisionId,
				}),
			);
		}
		if (method === "POST" && url.startsWith("/_emdash/api/content/posts/post_1/discard-draft")) {
			const index = discardCount++;
			if (options.onDiscardDraft) return options.onDiscardDraft(request, index);
			currentRevision = `rev-discard-${index + 1}`;
			currentDraftRevisionId = null;
			return contentResponse(
				makeItem({
					_rev: currentRevision,
					status: currentStatus,
					liveRevisionId: currentLiveRevisionId,
					draftRevisionId: currentDraftRevisionId,
				}),
			);
		}
		if (
			method === "POST" &&
			url.startsWith("/_emdash/api/revisions/") &&
			url.endsWith("/restore")
		) {
			const index = restoreCount++;
			if (options.onRestoreRevision) return options.onRestoreRevision(request, index);
			currentRevision = `rev-restore-${index + 1}`;
			currentStatus = "published";
			currentDraftRevisionId = "revision-restored";
			currentLiveRevisionId = "revision-restored";
			return contentResponse(
				makeItem({
					_rev: currentRevision,
					status: currentStatus,
					liveRevisionId: currentLiveRevisionId,
					draftRevisionId: currentDraftRevisionId,
					data: { title: "Restored title", website: "" },
				}),
			);
		}

		throw new Error(`Unhandled request: ${method} ${url}`);
	}) as typeof fetch;

	return {
		requests,
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

function buildRouter() {
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

	return { queryClient, router, TestApp };
}

async function renderEditPage() {
	const { router, TestApp } = buildRouter();
	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	const screen = await render(<TestApp />);
	await expect.element(screen.getByRole("textbox", { name: "Title" })).toBeVisible();
	return screen;
}

function contentMutations(requests: RecordedRequest[]) {
	return requests.filter(
		(request) =>
			request.method === "PUT" ||
			(request.method === "POST" &&
				(request.url.includes("/unpublish") ||
					request.url.includes("/discard-draft") ||
					request.url.includes("/publish"))),
	);
}

function unpublishRequests(requests: RecordedRequest[]) {
	return requests.filter(
		(request) => request.method === "POST" && request.url.includes("/unpublish"),
	);
}

function watchUnhandledRejections() {
	const rejections: PromiseRejectionEvent[] = [];
	const handler = (event: PromiseRejectionEvent) => {
		rejections.push(event);
	};
	window.addEventListener("unhandledrejection", handler);
	return {
		rejections,
		restore() {
			window.removeEventListener("unhandledrejection", handler);
		},
	};
}

describe("ContentEditPage revision token handling", () => {
	let server: ReturnType<typeof createMockServer> | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		await cleanup();
		server?.restore();
		server = undefined;
		vi.useRealTimers();
	});

	it("flushes pending edits before unpublish and advances the revision token", async () => {
		server = createMockServer();
		const screen = await renderEditPage();

		await screen.getByRole("textbox", { name: "Title" }).fill("Before unpublish");
		await screen.getByRole("button", { name: "Unpublish Post", exact: true }).click();
		await vi.advanceTimersByTimeAsync(0);

		const mutations = contentMutations(server.requests);
		expect(mutations.map(({ method }) => method)).toEqual(["PUT", "POST"]);
		expect(mutations[0]?.body).toMatchObject({
			data: { title: "Before unpublish" },
			_rev: "rev-initial",
		});
		expect(mutations[1]?.body).toMatchObject({ _rev: "rev-save-1" });

		await screen.getByRole("textbox", { name: "Title" }).fill("After unpublish");
		await vi.advanceTimersByTimeAsync(2000);

		await vi.waitFor(() => {
			expect(contentMutations(server.requests)).toHaveLength(3);
		});
		const autosave = contentMutations(server.requests)[2];
		expect(autosave?.body).toMatchObject({
			data: { title: "After unpublish" },
			_rev: "rev-unpublish-1",
		});
	});

	it("keeps the revision token current after unpublish so the next publish succeeds", async () => {
		server = createMockServer();
		const screen = await renderEditPage();

		await screen.getByRole("button", { name: "Unpublish Post", exact: true }).click();
		await vi.waitFor(() => {
			expect(
				server.requests.filter(
					(request) => request.method === "POST" && request.url.includes("/unpublish"),
				),
			).toHaveLength(1);
		});
		await vi.advanceTimersByTimeAsync(0);

		const publishTrigger = await vi.waitFor(() =>
			screen.getByRole("button", { name: "Publish", exact: true }),
		);
		await publishTrigger.click();
		const publishNow = screen.getByRole("menuitem", { name: /Publish now/ });
		await expect.element(publishNow).toBeVisible();
		fireEvent.click(publishNow.element());
		await vi.advanceTimersByTimeAsync(0);

		await vi.waitFor(() => {
			expect(contentMutations(server.requests).map(({ method }) => method)).toEqual([
				"POST",
				"PUT",
				"POST",
			]);
		});
		const mutations = contentMutations(server.requests);
		// The flush save after unpublish uses the token returned by unpublish.
		expect(mutations[1]?.body).toMatchObject({ _rev: "rev-unpublish-1" });
		// Publish uses the token returned by that flush save.
		expect(mutations[2]?.body).toMatchObject({ _rev: "rev-save-1" });
	});

	it("advances the revision token after discarding draft changes", async () => {
		server = createMockServer({
			initialDraftRevisionId: "revision-draft",
			initialStatus: "published",
		});
		const screen = await renderEditPage();

		await screen.getByRole("button", { name: "Discard changes", exact: true }).click();
		const dialog = screen.getByRole("dialog", { name: "Discard draft changes?" });
		fireEvent.click(dialog.getByRole("button", { name: "Discard changes", exact: true }).element());

		await vi.waitFor(() => {
			expect(
				server.requests.filter(
					(request) => request.method === "POST" && request.url.includes("/discard-draft"),
				),
			).toHaveLength(1);
		});

		await screen.getByRole("textbox", { name: "Title" }).fill("After discard");
		await vi.advanceTimersByTimeAsync(2000);

		await vi.waitFor(() => {
			expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
		});
		const autosave = server.requests.find((request) => request.method === "PUT");
		expect(autosave?.body).toMatchObject({
			data: { title: "After discard" },
			_rev: "rev-discard-1",
		});
	});

	it("does not raise an unhandled rejection when unpublish is blocked by invalid fields", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		const watcher = watchUnhandledRejections();
		try {
			await screen.getByRole("textbox", { name: "Website" }).fill("not a valid url");
			const button = screen.getByRole("button", { name: "Unpublish Post", exact: true });
			fireEvent.click(button.element());
			// The unhandledrejection event is dispatched asynchronously. Run the
			// rest of the assertion on real timers so the rejection can surface
			// before we check for it; fake timers complete the microtask too soon.
			vi.useRealTimers();
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(unpublishRequests(server.requests)).toHaveLength(0);
			expect(watcher.rejections).toHaveLength(0);
		} finally {
			watcher.restore();
		}
	});

	it("does not raise an unhandled rejection when unpublish is double-clicked", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		const watcher = watchUnhandledRejections();
		try {
			const button = screen.getByRole("button", { name: "Unpublish Post", exact: true });
			fireEvent.click(button.element());
			fireEvent.click(button.element());
			await vi.advanceTimersByTimeAsync(0);

			await vi.waitFor(() => {
				expect(unpublishRequests(server.requests)).toHaveLength(1);
			});
			expect(watcher.rejections).toHaveLength(0);
		} finally {
			watcher.restore();
		}
	});
});
