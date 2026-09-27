import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { fireEvent } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest, ContentItem, EntryRef } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "reference-autosave-cache",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
			hasSeo: false,
			fields: {
				title: { kind: "string", label: "Title" },
				authors: {
					kind: "reference",
					label: "Authors",
					validation: {
						relation: "posts_authors",
						relationSide: "parent",
						targetCollection: "authors",
						multiple: true,
					},
				},
			},
		},
		authors: {
			label: "Authors",
			labelSingular: "Author",
			supports: ["drafts", "revisions"],
			hasSeo: false,
			fields: { name: { kind: "string", label: "Name" } },
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

const AUTHORS: Record<string, EntryRef> = {
	author_ada: {
		id: "author_ada",
		slug: "ada",
		collection: "authors",
		title: "Ada Lovelace",
		locale: "en",
		translationGroup: "author_ada",
	},
	author_grace: {
		id: "author_grace",
		slug: "grace",
		collection: "authors",
		title: "Grace Hopper",
		locale: "en",
		translationGroup: "author_grace",
	},
};

function authorListItem(ref: EntryRef): ContentItem {
	return {
		id: ref.id,
		type: "authors",
		slug: ref.slug,
		status: "published",
		locale: "en",
		translationGroup: ref.translationGroup,
		data: { name: ref.title },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		publishedAt: "2026-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	};
}

function makePost(id: string, data: Record<string, unknown>, revision = 0): ContentItem {
	return {
		id,
		type: "posts",
		slug: id,
		status: "published",
		locale: "en",
		translationGroup: id,
		data,
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, revision)).toISOString(),
		publishedAt: "2026-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: "revision-live",
		draftRevisionId: id === "post_1" ? "revision-draft" : null,
	};
}

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

interface RecordedRequest {
	method: string;
	url: string;
	body: Record<string, unknown> | undefined;
}

/**
 * Serves one post whose `authors` selection lives on the server. Like the real
 * API, only the entry GET hydrates `references`; the PUT response carries none.
 */
function createMockServer(options: {
	initialAuthors: string[];
	onPut?: (request: RecordedRequest) => Promise<Response | undefined> | Response | undefined;
	/**
	 * Leaves the first entry read after a save unanswered, as a slow refetch would be,
	 * and holds the next one until `releaseRead()`.
	 */
	holdRefetchAfterSave?: boolean;
}) {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let savedAuthors = options.initialAuthors;
	let savedData: Record<string, unknown> = { title: "First post" };
	let revision = 0;
	let saved = false;
	let readsAfterSave = 0;
	let releaseHeldRead: (() => void) | undefined;

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
		if (method === "GET" && url.startsWith("/_emdash/api/content/authors")) {
			return jsonResponse({ data: { items: Object.values(AUTHORS).map(authorListItem) } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			if (options.holdRefetchAfterSave && saved) {
				readsAfterSave++;
				if (readsAfterSave === 1) return new Promise<Response>(() => {});
				if (readsAfterSave === 2) {
					await new Promise<void>((resolve) => {
						releaseHeldRead = resolve;
					});
				}
			}
			return jsonResponse({
				data: {
					item: {
						...makePost("post_1", savedData, revision),
						references: { authors: { children: savedAuthors.map((id) => AUTHORS[id]) } },
					},
					_rev: `rev-${revision}`,
				},
			});
		}
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_2")) {
			return jsonResponse({
				data: {
					item: {
						...makePost("post_2", { title: "Second post" }),
						references: { authors: { children: [] } },
					},
					_rev: "rev-post-2",
				},
			});
		}
		if (method === "GET" && url === "/_emdash/api/revisions/revision-draft") {
			return jsonResponse({
				data: {
					item: {
						id: "revision-draft",
						collection: "posts",
						entryId: "post_1",
						data: savedData,
						authorId: null,
						createdAt: "2026-01-02T00:00:00Z",
					},
				},
			});
		}
		if (method === "POST" && url.startsWith("/_emdash/api/content/posts/post_1/schedule")) {
			revision++;
			return jsonResponse({
				data: {
					item: {
						...makePost("post_1", savedData, revision),
						scheduledAt: String(body?.scheduledAt),
					},
					_rev: `rev-${revision}`,
				},
			});
		}
		if (method === "POST" && url.startsWith("/_emdash/api/content/posts/post_1/publish")) {
			revision++;
			return jsonResponse({
				data: {
					item: { ...makePost("post_1", savedData, revision), liveRevisionId: "revision-draft" },
					_rev: `rev-${revision}`,
				},
			});
		}
		if (method === "PUT" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			const response = options.onPut ? await options.onPut(request) : undefined;
			if (body?.data) savedData = body.data as Record<string, unknown>;
			const references = body?.references as Record<string, string[]> | undefined;
			if (references?.authors) savedAuthors = references.authors;
			saved = true;
			revision++;
			return (
				response ??
				jsonResponse({
					data: { item: makePost("post_1", savedData, revision), _rev: `rev-${revision}` },
				})
			);
		}

		throw new Error(`Unhandled request: ${method} ${url}`);
	}) as typeof fetch;

	return {
		requests,
		get readHeld() {
			return releaseHeldRead !== undefined;
		},
		releaseRead() {
			releaseHeldRead?.();
		},
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

async function renderPost() {
	// The admin's own client keeps a read fresh for a minute, so reopening an
	// entry within that minute renders from the cache.
	const queryClient = new QueryClient({
		defaultOptions: { queries: { staleTime: 60_000, retry: false } },
	});
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });

	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	const screen = await render(
		<I18nProvider i18n={i18n}>
			<ThemeProvider defaultTheme="light">
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</ThemeProvider>
		</I18nProvider>,
	);
	await expect.element(screen.getByRole("textbox", { name: "Title" })).toHaveValue("First post");
	return { screen, router };
}

async function reopenPost(router: ReturnType<typeof createAdminRouter>) {
	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_2" },
	});
	await vi.advanceTimersByTimeAsync(100);
	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	await vi.advanceTimersByTimeAsync(100);
}

async function pickAuthor(screen: Awaited<ReturnType<typeof render>>, name: string) {
	await screen.getByRole("button", { name: "Add reference" }).click();
	const dialog = screen.getByRole("dialog");
	const checkbox = dialog.getByText(name);
	await expect.element(checkbox).toBeVisible();
	checkbox.element().click();
	const add = dialog.getByRole("button", { name: /^Add selected/ });
	await expect.element(add).toBeEnabled();
	add.element().click();
}

function localDateKey(date: Date): string {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

async function scheduleForTomorrow(screen: Awaited<ReturnType<typeof render>>) {
	await screen.getByRole("button", { name: "Schedule" }).click();
	await vi.advanceTimersByTimeAsync(150);
	const dialog = screen.getByRole("dialog", { name: "Schedule changes" });
	const tomorrow = new Date();
	tomorrow.setDate(tomorrow.getDate() + 1);
	const dayButton = dialog
		.element()
		.querySelector<HTMLButtonElement>(`[data-day="${localDateKey(tomorrow)}"] button`);
	expect(dayButton).not.toBeNull();
	fireEvent.click(dayButton!);
	await dialog.getByRole("textbox", { name: "Hour" }).fill("09");
	await dialog.getByRole("textbox", { name: "Minute" }).fill("00");
	fireEvent.click(dialog.getByRole("button", { name: "Schedule changes", exact: true }).element());
}

function autosaves(requests: RecordedRequest[]) {
	return requests.filter((request) => request.method === "PUT");
}

describe("reference field after a save", () => {
	let server: ReturnType<typeof createMockServer> | undefined;

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		server?.restore();
		server = undefined;
		vi.useRealTimers();
	});

	it("still lists the saved entries when the entry is reopened after a text autosave", async () => {
		server = createMockServer({ initialAuthors: ["author_ada"] });
		const { screen, router } = await renderPost();
		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();

		await screen.getByRole("textbox", { name: "Title" }).fill("Edited title");
		await vi.advanceTimersByTimeAsync(2500);
		expect(autosaves(server.requests)).toHaveLength(1);

		await reopenPost(router);

		await expect
			.element(screen.getByRole("textbox", { name: "Title" }))
			.toHaveValue("Edited title");
		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();
		expect(screen.getByText("No references selected.").query()).toBeNull();
	});

	it("lists an autosaved pick when the entry is reopened, and the next edit starts from it", async () => {
		server = createMockServer({ initialAuthors: ["author_ada"] });
		const { screen, router } = await renderPost();
		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();

		await pickAuthor(screen, "Grace Hopper");
		await vi.advanceTimersByTimeAsync(2500);
		expect(autosaves(server.requests).at(-1)?.body?.references).toEqual({
			authors: ["author_ada", "author_grace"],
		});

		await reopenPost(router);

		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();
		await expect.element(screen.getByText("Grace Hopper")).toBeVisible();

		await screen.getByRole("button", { name: "Remove Grace Hopper" }).click();
		await vi.advanceTimersByTimeAsync(2500);
		expect(autosaves(server.requests).at(-1)?.body?.references).toEqual({
			authors: ["author_ada"],
		});
	});

	it("still lists the saved entries when the entry is reopened after publishing", async () => {
		server = createMockServer({ initialAuthors: ["author_ada"] });
		const { screen, router } = await renderPost();
		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();

		await screen.getByRole("button", { name: "Publish changes", exact: true }).click();
		const confirm = screen
			.getByRole("dialog", { name: "Publish changes?" })
			.getByRole("button", { name: "Publish changes", exact: true });
		await expect.element(confirm).toBeVisible();
		confirm.element().click();
		await vi.advanceTimersByTimeAsync(150);
		expect(server.requests.some((request) => request.url.includes("/publish"))).toBe(true);

		await reopenPost(router);

		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();
		expect(screen.getByText("No references selected.").query()).toBeNull();
	});

	it("still lists the saved entries when the entry is reopened after scheduling", async () => {
		server = createMockServer({ initialAuthors: ["author_ada"] });
		const { screen, router } = await renderPost();
		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();

		await screen.getByRole("textbox", { name: "Title" }).fill("Scheduled title");
		await scheduleForTomorrow(screen);
		await vi.waitFor(() => {
			expect(server!.requests.some((request) => request.url.includes("/schedule"))).toBe(true);
		});
		await vi.advanceTimersByTimeAsync(150);

		await reopenPost(router);

		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();
		expect(screen.getByText("No references selected.").query()).toBeNull();
	});

	it("keeps a pick made just before scheduling, in the open editor and after a reopen", async () => {
		server = createMockServer({ initialAuthors: ["author_ada"], holdRefetchAfterSave: true });
		const { screen, router } = await renderPost();
		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();

		await pickAuthor(screen, "Grace Hopper");
		await scheduleForTomorrow(screen);
		await vi.waitFor(() => {
			expect(server!.requests.some((request) => request.url.includes("/schedule"))).toBe(true);
		});
		await vi.advanceTimersByTimeAsync(150);
		expect(autosaves(server.requests).at(-1)?.body?.references).toEqual({
			authors: ["author_ada", "author_grace"],
		});
		await vi.waitFor(() => expect(server!.readHeld).toBe(true));
		await vi.advanceTimersByTimeAsync(100);
		await expect.element(screen.getByText("Grace Hopper")).toBeVisible();

		server.releaseRead();
		await vi.advanceTimersByTimeAsync(100);
		await reopenPost(router);

		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();
		await expect.element(screen.getByText("Grace Hopper")).toBeVisible();
	});

	it("keeps a pick made just before publishing, in the open editor and after a reopen", async () => {
		server = createMockServer({ initialAuthors: ["author_ada"], holdRefetchAfterSave: true });
		const { screen, router } = await renderPost();
		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();

		await pickAuthor(screen, "Grace Hopper");
		await screen.getByRole("button", { name: "Publish changes", exact: true }).click();
		const confirm = screen
			.getByRole("dialog", { name: "Publish changes?" })
			.getByRole("button", { name: "Publish changes", exact: true });
		await expect.element(confirm).toBeVisible();
		confirm.element().click();
		await vi.waitFor(() => {
			expect(server!.requests.some((request) => request.url.includes("/publish"))).toBe(true);
		});
		await vi.advanceTimersByTimeAsync(150);
		expect(autosaves(server.requests).at(-1)?.body?.references).toEqual({
			authors: ["author_ada", "author_grace"],
		});
		await vi.waitFor(() => expect(server!.readHeld).toBe(true));
		await vi.advanceTimersByTimeAsync(100);
		await expect.element(screen.getByText("Grace Hopper")).toBeVisible();

		server.releaseRead();
		await vi.advanceTimersByTimeAsync(100);
		await reopenPost(router);

		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();
		await expect.element(screen.getByText("Grace Hopper")).toBeVisible();
	});

	it("keeps a pick made while the autosave is in flight", async () => {
		let releasePut!: () => void;
		const putHeld = new Promise<void>((resolve) => {
			releasePut = resolve;
		});
		let firstPut = true;
		server = createMockServer({
			initialAuthors: [],
			onPut: async () => {
				if (firstPut) {
					firstPut = false;
					await putHeld;
				}
				return undefined;
			},
		});
		const { screen } = await renderPost();
		await expect.element(screen.getByText("No references selected.")).toBeVisible();

		await pickAuthor(screen, "Ada Lovelace");
		await vi.advanceTimersByTimeAsync(2500);
		expect(autosaves(server.requests)).toHaveLength(1);

		await pickAuthor(screen, "Grace Hopper");
		releasePut();
		await vi.advanceTimersByTimeAsync(100);

		await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();
		await expect.element(screen.getByText("Grace Hopper")).toBeVisible();

		await vi.advanceTimersByTimeAsync(2500);
		expect(autosaves(server.requests).at(-1)?.body?.references).toEqual({
			authors: ["author_ada", "author_grace"],
		});
	});
});
