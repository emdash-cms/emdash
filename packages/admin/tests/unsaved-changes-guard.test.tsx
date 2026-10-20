import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const OTHER = { ...CREATED, id: "post_other", slug: "other", data: { title: "Other title" } };

const CONFLICT = { error: { code: "CONFLICT", message: "This entry changed somewhere else." } };
const LOCKED = {
	error: {
		code: "ENTRY_LOCKED",
		message: "Someone else is editing this entry.",
		details: { userId: "user_02" },
	},
};

async function renderEditor(
	open: (
		router: ReturnType<typeof createAdminRouter>,
		queryClient: ReturnType<typeof createTestQueryClient>,
	) => Promise<void>,
) {
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

	await open(router, queryClient);
	const screen = await render(<TestApp />);
	const title = screen.getByRole("textbox", { name: "Title", exact: true });
	await expect.element(title).toBeVisible();
	return { router, screen, title };
}

function renderNewEntry() {
	return renderEditor((router) =>
		router.navigate({ to: "/content/$collection/new", params: { collection: "posts" } }),
	);
}

function renderSavedEntry() {
	return renderEditor((router) =>
		router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: CREATED.id },
		}),
	);
}

/** Collects the body of every PUT sent from now on. */
function recordPuts() {
	const bodies: Array<{ data?: unknown }> = [];
	const send = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		if (init?.method === "PUT" && typeof init.body === "string") bodies.push(JSON.parse(init.body));
		return send(input, init);
	}) as typeof fetch;
	return bodies;
}

/** Holds every read of the saved entry from now on. */
function holdEntryReads() {
	const send = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const read = typeof input === "string" && input.includes(`/content/posts/${CREATED.id}`);
		return read && (init?.method ?? "GET") === "GET"
			? new Promise<Response>(() => {})
			: send(input, init);
	}) as typeof fetch;
}

/** Holds every PUT from now on until `release`; `answered` settles once one has its response. */
function holdPuts() {
	let release = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let answer = () => {};
	const answered = new Promise<void>((resolve) => {
		answer = resolve;
	});
	const send = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		if (init?.method !== "PUT") return send(input, init);
		await released;
		const response = await send(input, init);
		answer();
		return response;
	}) as typeof fetch;
	return { release, answered };
}

function reloadIsBlocked() {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

function leaveForPostList(router: ReturnType<typeof createAdminRouter>) {
	return router.navigate({ to: "/content/$collection", params: { collection: "posts" } });
}

function openPost(router: ReturnType<typeof createAdminRouter>, id: string) {
	return router.navigate({ to: "/content/$collection/$id", params: { collection: "posts", id } });
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

		expect(reloadIsBlocked()).toBe(false);
		await title.fill("Unsaved title");
		await expect.poll(reloadIsBlocked).toBe(true);
	});

	it("opens the created entry after Save without asking", async () => {
		const { router, screen, title } = await renderNewEntry();
		await title.fill("Unsaved title");

		screen.getByRole("button", { name: "Save" }).element().click();

		await expect.poll(() => router.state.location.pathname).toMatch(/\/content\/posts\/post_new$/);
		expect(screen.container.ownerDocument.querySelector('[role="dialog"]')).toBeNull();
	});

	it("saves a saved entry's edits on leaving before the autosave runs", async () => {
		const puts = recordPuts();
		const { router, screen, title } = await renderSavedEntry();
		await title.fill("Edited title");
		expect(puts).toHaveLength(0);

		await leaveForPostList(router);

		expect(router.state.location.pathname).toMatch(/\/content\/posts$/);
		expect(screen.container.ownerDocument.querySelector('[role="dialog"]')).toBeNull();
		await expect.poll(() => puts.at(-1)?.data).toEqual({ title: "Edited title" });
	});

	it("counts a saved entry's edits as saved once Save succeeds, before the entry is read again", async () => {
		mockFetch.on("PUT", `/_emdash/api/content/posts/${CREATED.id}?locale=en`, {
			data: { item: { ...CREATED, data: { title: "Edited title" } }, _rev: "rev-2" },
		});
		const { screen, title } = await renderSavedEntry();
		await title.fill("Edited title");
		await expect.poll(reloadIsBlocked).toBe(true);

		holdEntryReads();
		screen.getByRole("button", { name: "Save", exact: true }).element().click();

		await expect.poll(reloadIsBlocked).toBe(false);
	});

	it("leaves a saved entry moved to the trash without saving or asking", async () => {
		mockFetch.on("DELETE", `/_emdash/api/content/posts/${CREATED.id}?locale=en`, { data: {} });
		const puts = recordPuts();
		const { router, screen, title } = await renderSavedEntry();
		await title.fill("Edited title");

		screen.getByRole("button", { name: "Move to Trash" }).element().click();
		const confirm = screen.getByRole("dialog", { name: "Move to Trash?" });
		await expect.element(confirm).toBeVisible();
		confirm.getByRole("button", { name: "Move to Trash" }).element().click();

		await expect.poll(() => router.state.location.pathname).toMatch(/\/content\/posts$/);
		expect(screen.getByRole("dialog", { name: "Leave without saving?" }).query()).toBeNull();
		expect(puts).toHaveLength(0);
	});

	it("keeps the next entry clean when a Save sent from the previous one lands after the switch", async () => {
		mockFetch
			.on("GET", `/_emdash/api/content/posts/${OTHER.id}`, { data: { item: OTHER } })
			.on("PUT", `/_emdash/api/content/posts/${CREATED.id}?locale=en`, {
				data: { item: { ...CREATED, data: { title: "Edited title" } }, _rev: "rev-2" },
			});
		// Kept in the cache, so switching entries keeps the editor mounted.
		const { router, screen, title } = await renderEditor((start, queryClient) => {
			queryClient.setQueryDefaults(["content"], { gcTime: Infinity });
			return openPost(start, OTHER.id);
		});
		await openPost(router, CREATED.id);
		await expect.element(title).toHaveValue("Unsaved title");
		await title.fill("Edited title");

		const save = holdPuts();
		screen.getByRole("button", { name: "Save", exact: true }).element().click();
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeVisible();
		await openPost(router, OTHER.id);
		await expect.element(title).toHaveValue("Other title");
		save.release();
		await save.answered;
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(reloadIsBlocked()).toBe(false);
	});

	it("asks before leaving an entry whose edits match a Publish still running on the previous one", async () => {
		const twin = { ...CREATED, id: "post_twin" };
		mockFetch.on("GET", `/_emdash/api/content/posts/${twin.id}`, { data: { item: twin } });
		const { router, screen, title } = await renderEditor((start, queryClient) => {
			queryClient.setQueryDefaults(["content"], { gcTime: Infinity });
			return openPost(start, twin.id);
		});
		await openPost(router, CREATED.id);
		await expect.element(title).toHaveValue("Unsaved title");
		await title.fill("Edited title");

		holdPuts();
		screen.getByRole("button", { name: "Publish now", exact: true }).element().click();
		const confirm = screen.getByRole("dialog", { name: "Publish now?" });
		await expect.element(confirm).toBeVisible();
		confirm.getByRole("button", { name: "Publish now", exact: true }).element().click();
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeVisible();
		await openPost(router, twin.id);
		await expect.element(title).toHaveValue("Unsaved title");
		await title.fill("Edited title");

		void leaveForPostList(router);

		await expect
			.element(screen.getByRole("dialog", { name: "Leave without saving?" }))
			.toBeVisible();
	});

	it("saves an entry's edits on leaving when they match an autosave that landed on the previous one", async () => {
		const twin = { ...CREATED, id: "post_twin" };
		mockFetch
			.on("GET", `/_emdash/api/content/posts/${twin.id}`, { data: { item: twin } })
			.on("PUT", `/_emdash/api/content/posts/${CREATED.id}?locale=en`, {
				data: { item: { ...CREATED, data: { title: "Edited title" } }, _rev: "rev-2" },
			})
			.on("PUT", `/_emdash/api/content/posts/${twin.id}?locale=en`, {
				data: { item: { ...twin, data: { title: "Edited title" } }, _rev: "rev-2" },
			});
		const { router, title } = await renderEditor((start, queryClient) => {
			queryClient.setQueryDefaults(["content"], { gcTime: Infinity });
			return openPost(start, twin.id);
		});
		await openPost(router, CREATED.id);
		await expect.element(title).toHaveValue("Unsaved title");
		const puts = recordPuts();
		await title.fill("Edited title");
		await expect.poll(() => puts.length, { timeout: 5000 }).toBe(1);
		await expect.poll(reloadIsBlocked).toBe(false);
		await openPost(router, twin.id);
		await expect.element(title).toHaveValue("Unsaved title");
		await title.fill("Edited title");

		await leaveForPostList(router);

		expect(puts.map((put) => put.data)).toEqual([
			{ title: "Edited title" },
			{ title: "Edited title" },
		]);
	});

	it("keeps an entry reopened while its Save was on the way from sending its old content", async () => {
		mockFetch
			.on("GET", `/_emdash/api/content/posts/${OTHER.id}`, { data: { item: OTHER } })
			.on("PUT", `/_emdash/api/content/posts/${CREATED.id}?locale=en`, {
				data: { item: { ...CREATED, data: { title: "Edited title" } }, _rev: "rev-2" },
			});
		const { router, screen, title } = await renderEditor((start, queryClient) => {
			queryClient.setQueryDefaults(["content"], { gcTime: Infinity });
			return openPost(start, OTHER.id);
		});
		await openPost(router, CREATED.id);
		await expect.element(title).toHaveValue("Unsaved title");
		await title.fill("Edited title");

		const puts = recordPuts();
		const save = holdPuts();
		screen.getByRole("button", { name: "Save", exact: true }).element().click();
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeVisible();
		await openPost(router, OTHER.id);
		await expect.element(title).toHaveValue("Other title");
		holdEntryReads();
		await openPost(router, CREATED.id);
		await expect.element(title).toHaveValue("Unsaved title");
		save.release();
		await save.answered;
		await new Promise((resolve) => setTimeout(resolve, 50));

		await leaveForPostList(router);

		expect(puts.map((put) => put.data)).toEqual([{ title: "Edited title" }]);
	});

	it.each([
		["leaves at once", true],
		["stays past the autosave delay", false],
	])(
		"keeps an entry reopened while its autosave was on the way from sending its old content when the writer %s",
		async (_writer, leave) => {
			mockFetch
				.on("GET", `/_emdash/api/content/posts/${OTHER.id}`, { data: { item: OTHER } })
				.on("PUT", `/_emdash/api/content/posts/${CREATED.id}?locale=en`, {
					data: { item: { ...CREATED, data: { title: "Edited title" } }, _rev: "rev-2" },
				});
			const { router, title } = await renderEditor((start, queryClient) => {
				queryClient.setQueryDefaults(["content"], { gcTime: Infinity });
				return openPost(start, OTHER.id);
			});
			await openPost(router, CREATED.id);
			await expect.element(title).toHaveValue("Unsaved title");

			const autosave = holdPuts();
			const puts = recordPuts();
			await title.fill("Edited title");
			await expect.poll(() => puts.length, { timeout: 5000 }).toBe(1);
			await openPost(router, OTHER.id);
			await expect.element(title).toHaveValue("Other title");
			holdEntryReads();
			await openPost(router, CREATED.id);
			await expect.element(title).toHaveValue("Unsaved title");
			autosave.release();
			await expect.element(title).toHaveValue("Edited title");

			if (leave) await leaveForPostList(router);
			else await new Promise((resolve) => setTimeout(resolve, 3000));

			expect(puts.map((put) => put.data)).toEqual([{ title: "Edited title" }]);
		},
		10_000,
	);

	it("after switching entries, saves a revert made while the autosave is on its way", async () => {
		mockFetch
			.on("GET", `/_emdash/api/content/posts/${OTHER.id}`, { data: { item: OTHER } })
			.on("PUT", `/_emdash/api/content/posts/${CREATED.id}?locale=en`, {
				data: { item: { ...CREATED, data: { title: "Edited title" } }, _rev: "rev-2" },
			});
		const { router, title } = await renderEditor((start, queryClient) => {
			queryClient.setQueryDefaults(["content"], { gcTime: Infinity });
			return openPost(start, CREATED.id);
		});
		await openPost(router, OTHER.id);
		await expect.element(title).toHaveValue("Other title");
		await openPost(router, CREATED.id);
		await expect.element(title).toHaveValue("Unsaved title");

		const autosave = holdPuts();
		const puts = recordPuts();
		await title.fill("Edited title");
		await expect.poll(() => puts.length, { timeout: 5000 }).toBe(1);
		await title.fill("Unsaved title");
		autosave.release();

		await expect.poll(() => puts.length, { timeout: 5000 }).toBe(2);
		expect(puts.at(-1)?.data).toEqual({ title: "Unsaved title" });
		await expect.element(title).toHaveValue("Unsaved title");
	}, 10_000);

	it.each([
		["an autosave", "a conflict", CONFLICT, "Autosave failed"],
		["an autosave", "another editor's lock", LOCKED, "Autosave failed"],
		["a Save", "a conflict", CONFLICT, "Failed to save"],
		["a Save", "another editor's lock", LOCKED, "Failed to save"],
	] as const)(
		"reports %s refused because of %s after the editor has closed",
		async (write, _refusal, body, toast) => {
			mockFetch.on("PUT", `/_emdash/api/content/posts/${CREATED.id}?locale=en`, body, 409);
			const { router, screen, title } = await renderSavedEntry();
			await title.fill("Edited title");

			const put = holdPuts();
			if (write === "a Save") {
				screen.getByRole("button", { name: "Save", exact: true }).element().click();
				await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeVisible();
			}
			await leaveForPostList(router);
			put.release();

			await expect.element(screen.getByText(toast)).toBeVisible();
		},
	);

	describe("after a failed autosave", () => {
		beforeEach(() => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("asks before leaving a saved entry", async () => {
			mockFetch.on(
				"PUT",
				`/_emdash/api/content/posts/${CREATED.id}?locale=en`,
				{ error: { code: "INTERNAL_ERROR", message: "Unavailable" } },
				500,
			);
			const puts = recordPuts();
			const { router, screen, title } = await renderSavedEntry();
			await title.fill("Edited title");
			await vi.advanceTimersByTimeAsync(2500);
			expect(puts).toHaveLength(1);

			void leaveForPostList(router);
			const dialog = screen.getByRole("dialog", { name: "Leave without saving?" });
			await expect.element(dialog).toBeVisible();
			screen.getByRole("button", { name: "Stay" }).element().click();

			await expect.element(dialog).not.toBeInTheDocument();
			expect(router.state.location.pathname).toMatch(/\/content\/posts\/post_new$/);
		});

		it("saves on leaving again once a Save has gone through", async () => {
			const url = `/_emdash/api/content/posts/${CREATED.id}?locale=en`;
			mockFetch.on("PUT", url, { error: { code: "INTERNAL_ERROR", message: "Unavailable" } }, 500);
			const puts = recordPuts();
			const { router, screen, title } = await renderSavedEntry();
			await title.fill("Edited title");
			await vi.advanceTimersByTimeAsync(2500);
			expect(puts).toHaveLength(1);

			const saved = { ...CREATED, data: { title: "Saved title" } };
			mockFetch
				.on("PUT", url, { data: { item: saved, _rev: "rev-2" } })
				.on("GET", `/_emdash/api/content/posts/${CREATED.id}`, { data: { item: saved } });
			screen.getByRole("button", { name: "Save", exact: true }).element().click();
			await expect.element(title).toHaveValue("Saved title");
			await title.fill("Edited again");

			void leaveForPostList(router);

			await expect.poll(() => router.state.location.pathname).toMatch(/\/content\/posts$/);
			expect(puts.at(-1)?.data).toEqual({ title: "Edited again" });
		});
	});
});
