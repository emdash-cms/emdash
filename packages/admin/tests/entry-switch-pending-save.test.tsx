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
		pages: {
			label: "Pages",
			labelSingular: "Page",
			supports: ["drafts"],
			hasSeo: false,
			fields: { title: { kind: "string", label: "Title" } },
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

const ENTRY = {
	id: "post_a",
	type: "posts",
	slug: "entry-a",
	status: "draft",
	locale: "en",
	translationGroup: null,
	data: { title: "First title" },
	authorId: null,
	primaryBylineId: null,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	publishedAt: null,
	scheduledAt: null,
	liveRevisionId: null,
	draftRevisionId: null,
};

const OTHER = { ...ENTRY, id: "post_b", slug: "entry-b", data: { title: "Other title" } };

const PAGE = { ...OTHER, id: "page_c", type: "pages", slug: "page-c" };

const PUBLISHED = {
	...ENTRY,
	status: "published",
	publishedAt: "2026-01-01T00:00:00Z",
	liveRevisionId: "revision-live",
};

const SCHEDULED = { ...ENTRY, scheduledAt: "2030-01-01T09:00:00.000Z" };

const ENTRY_PATH = `/_emdash/api/content/posts/${ENTRY.id}`;

type Entry = { id: string; type: string };
type Screen = Awaited<ReturnType<typeof render>>;

async function renderEditorFrom(other: Entry) {
	const queryClient = createTestQueryClient();
	// Kept in the cache, so switching entries keeps the editor mounted.
	queryClient.setQueryDefaults(["content"], { gcTime: Infinity });
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

	await openEntry(router, other);
	const screen = await render(<TestApp />);
	const title = screen.getByRole("textbox", { name: "Title", exact: true });
	await expect.element(title).toHaveValue("Other title");
	await openEntry(router, ENTRY);
	await expect.element(title).toHaveValue("First title");
	return { queryClient, router, screen, title };
}

function openEntry(router: ReturnType<typeof createAdminRouter>, entry: Entry) {
	return router.navigate({
		to: "/content/$collection/$id",
		params: { collection: entry.type, id: entry.id },
	});
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

/** Collects every write sent to an entry from now on, leaving out its edit lock. */
function recordEntryWrites() {
	const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
	const send = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		if (
			typeof input === "string" &&
			input.includes("/content/") &&
			!input.includes("/lock") &&
			method !== "GET"
		) {
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
			writes.push({ method, path: input, body });
		}
		return send(input, init);
	}) as typeof fetch;
	return writes;
}

/** Answers every publication date change with a conflict and collects the reads of the first entry. */
function refuseDateChanges() {
	const reads: string[] = [];
	const send = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		if (typeof input === "string" && method === "GET" && input.split("?")[0]?.endsWith(ENTRY.id)) {
			reads.push(input);
		}
		if (
			method === "PUT" &&
			typeof init?.body === "string" &&
			"publishedAt" in JSON.parse(init.body)
		) {
			const body = { error: { code: "CONFLICT", message: "This entry changed somewhere else." } };
			const headers = { "Content-Type": "application/json" };
			return Promise.resolve(new Response(JSON.stringify(body), { status: 409, headers }));
		}
		return send(input, init);
	}) as typeof fetch;
	return reads;
}

async function changePublicationDate(screen: Screen) {
	screen
		.getByRole("button", { name: /Change publication date/ })
		.element()
		.click();
	const dialog = screen.getByRole("dialog", { name: "Change publication date" });
	await dialog.getByRole("textbox", { name: "Minute" }).fill("07");
	dialog.getByRole("button", { name: "Save date", exact: true }).element().click();
}

function localDateKey(date: Date) {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

const ACTIONS: Array<{
	title: string;
	item: object;
	act: (screen: Screen) => Promise<void> | void;
	write: Record<string, unknown>;
}> = [
	{
		title: "publishes the entry Publish was clicked on",
		item: ENTRY,
		act: async (screen) => {
			screen.getByRole("button", { name: "Publish now", exact: true }).element().click();
			const confirm = screen.getByRole("dialog", { name: "Publish now?" });
			await expect.element(confirm).toBeVisible();
			confirm.getByRole("button", { name: "Publish now", exact: true }).element().click();
		},
		write: { method: "POST", path: `${ENTRY_PATH}/publish?locale=en`, body: { _rev: "rev-2" } },
	},
	{
		title: "unpublishes the entry Unpublish was clicked on",
		item: PUBLISHED,
		act: (screen) => {
			screen.getByRole("button", { name: "Unpublish Post", exact: true }).element().click();
		},
		write: { method: "POST", path: `${ENTRY_PATH}/unpublish?locale=en`, body: { _rev: "rev-2" } },
	},
	{
		title: "schedules the entry the schedule was set on",
		item: ENTRY,
		act: async (screen) => {
			screen.getByRole("button", { name: "Schedule", exact: true }).element().click();
			const dialog = screen.getByRole("dialog", { name: "Schedule publication" });
			await expect.element(dialog).toBeVisible();
			const tomorrow = new Date();
			tomorrow.setDate(tomorrow.getDate() + 1);
			const day = dialog
				.element()
				.querySelector<HTMLButtonElement>(`[data-day="${localDateKey(tomorrow)}"] button`);
			expect(day).not.toBeNull();
			day!.click();
			await dialog.getByRole("textbox", { name: "Hour" }).fill("09");
			await dialog.getByRole("textbox", { name: "Minute" }).fill("00");
			dialog.getByRole("button", { name: "Schedule", exact: true }).element().click();
		},
		write: { method: "POST", path: `${ENTRY_PATH}/schedule?locale=en` },
	},
	{
		title: "removes the schedule from the entry it was removed on",
		item: SCHEDULED,
		act: (screen) => {
			screen.getByRole("button", { name: "Remove schedule" }).element().click();
		},
		write: { method: "DELETE", path: `${ENTRY_PATH}/schedule?locale=en` },
	},
	{
		title: "changes the publication date of the entry it was set on",
		item: PUBLISHED,
		act: changePublicationDate,
		write: {
			method: "PUT",
			path: `${ENTRY_PATH}?locale=en`,
			body: { publishedAt: expect.any(String) },
		},
	},
];

describe.each([
	["the same collection", OTHER],
	["another collection", PAGE],
])("switching to an entry in %s while a save is on its way", (_, other) => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } })
			.on("GET", "/_emdash/api/bylines", { data: { items: [], nextCursor: null } })
			.on("GET", "/_emdash/api/content/posts?", { data: { items: [], nextCursor: null } })
			.on("GET", "/_emdash/api/content/pages?", { data: { items: [], nextCursor: null } })
			.on("GET", `/_emdash/api/content/posts/${OTHER.id}`, { data: { item: OTHER } })
			.on("GET", `/_emdash/api/content/pages/${PAGE.id}`, { data: { item: PAGE } })
			.on("PUT", `${ENTRY_PATH}?locale=en`, {
				data: { item: { ...ENTRY, data: { title: "Edited title" } }, _rev: "rev-2" },
			});
	});

	afterEach(() => {
		mockFetch.restore();
	});

	/** Opens `item` as the first entry and edits it, then starts `act` and opens `other` before the save lands. */
	async function actThenSwitch(item: object, act: (screen: Screen) => Promise<void> | void) {
		mockFetch.on("GET", ENTRY_PATH, { data: { item, _rev: "rev-1" } });
		const writes = recordEntryWrites();
		const { queryClient, router, screen, title } = await renderEditorFrom(other);
		await title.fill("Edited title");

		const save = holdPuts();
		await act(screen);
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeVisible();
		await openEntry(router, other);
		await expect.element(title).toHaveValue("Other title");
		save.release();
		await save.answered;

		await expect.poll(() => writes.length).toBe(2);
		return { queryClient, writes };
	}

	for (const { title: action, item, act, write } of ACTIONS) {
		it(`${action} once its save lands`, async () => {
			const { writes } = await actThenSwitch(item, act);

			expect(writes[1]).toMatchObject(write);
		});
	}

	it("refreshes the entry whose publication date it changed", async () => {
		const { queryClient } = await actThenSwitch(PUBLISHED, changePublicationDate);

		await expect
			.poll(() => queryClient.getQueryState(["content", "posts", ENTRY.id, { locale: undefined }]))
			.toMatchObject({ isInvalidated: true });
	});

	it("reads back the entry whose publication date change conflicted", async () => {
		const reads = refuseDateChanges();
		await actThenSwitch(PUBLISHED, changePublicationDate);

		await expect.poll(() => reads).toContain(`${ENTRY_PATH}?locale=en`);
	});
});
