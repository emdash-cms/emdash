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

const PUBLISHED = {
	...ENTRY,
	status: "published",
	publishedAt: "2026-01-01T00:00:00Z",
	liveRevisionId: "revision-live",
};

const SCHEDULED = { ...ENTRY, scheduledAt: "2030-01-01T09:00:00.000Z" };

const ENTRY_PATH = `/_emdash/api/content/posts/${ENTRY.id}`;

async function renderEditorFromOther() {
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

	await openPost(router, OTHER.id);
	const screen = await render(<TestApp />);
	const title = screen.getByRole("textbox", { name: "Title", exact: true });
	await expect.element(title).toHaveValue("Other title");
	await openPost(router, ENTRY.id);
	await expect.element(title).toHaveValue("First title");
	return { router, screen, title };
}

function openPost(router: ReturnType<typeof createAdminRouter>, id: string) {
	return router.navigate({ to: "/content/$collection/$id", params: { collection: "posts", id } });
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
			input.includes("/content/posts/") &&
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

function localDateKey(date: Date) {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

describe("switching entries while a save is on its way", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } })
			.on("GET", "/_emdash/api/bylines", { data: { items: [], nextCursor: null } })
			.on("GET", "/_emdash/api/content/posts?", { data: { items: [], nextCursor: null } })
			.on("GET", `/_emdash/api/content/posts/${OTHER.id}`, { data: { item: OTHER } })
			.on("PUT", `${ENTRY_PATH}?locale=en`, {
				data: { item: { ...ENTRY, data: { title: "Edited title" } }, _rev: "rev-2" },
			});
	});

	afterEach(() => {
		mockFetch.restore();
	});

	/**
	 * Opens `item` as the first entry and edits it, then runs `act` with saves held and opens the
	 * other entry before releasing them. Resolves with the save and the write `act` led to.
	 */
	async function actThenSwitch(
		item: object,
		act: (screen: Awaited<ReturnType<typeof render>>) => Promise<void> | void,
	) {
		mockFetch.on("GET", ENTRY_PATH, { data: { item, _rev: "rev-1" } });
		const writes = recordEntryWrites();
		const { router, screen, title } = await renderEditorFromOther();
		await title.fill("Edited title");

		const save = holdPuts();
		await act(screen);
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeVisible();
		await openPost(router, OTHER.id);
		await expect.element(title).toHaveValue("Other title");
		save.release();
		await save.answered;

		await expect.poll(() => writes.length).toBe(2);
		return writes;
	}

	it("publishes the entry Publish was clicked on when its save lands after a switch", async () => {
		const writes = await actThenSwitch(ENTRY, async (screen) => {
			screen.getByRole("button", { name: "Publish now", exact: true }).element().click();
			const confirm = screen.getByRole("dialog", { name: "Publish now?" });
			await expect.element(confirm).toBeVisible();
			confirm.getByRole("button", { name: "Publish now", exact: true }).element().click();
		});

		expect(writes[1]).toMatchObject({
			method: "POST",
			path: `${ENTRY_PATH}/publish?locale=en`,
			body: { _rev: "rev-2" },
		});
	});

	it("unpublishes the entry Unpublish was clicked on when its save lands after a switch", async () => {
		const writes = await actThenSwitch(PUBLISHED, (screen) => {
			screen.getByRole("button", { name: "Unpublish Post", exact: true }).element().click();
		});

		expect(writes[1]).toMatchObject({
			method: "POST",
			path: `${ENTRY_PATH}/unpublish?locale=en`,
			body: { _rev: "rev-2" },
		});
	});

	it("schedules the entry the schedule was set on when its save lands after a switch", async () => {
		const writes = await actThenSwitch(ENTRY, async (screen) => {
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
		});

		expect(writes[1]).toMatchObject({ method: "POST", path: `${ENTRY_PATH}/schedule?locale=en` });
	});

	it("removes the schedule from the entry it was removed on when its save lands after a switch", async () => {
		const writes = await actThenSwitch(SCHEDULED, (screen) => {
			screen.getByRole("button", { name: "Remove schedule" }).element().click();
		});

		expect(writes[1]).toMatchObject({ method: "DELETE", path: `${ENTRY_PATH}/schedule?locale=en` });
	});

	it("changes the publication date of the entry it was set on when its save lands after a switch", async () => {
		const writes = await actThenSwitch(PUBLISHED, async (screen) => {
			screen
				.getByRole("button", { name: /Change publication date/ })
				.element()
				.click();
			const dialog = screen.getByRole("dialog", { name: "Change publication date" });
			await dialog.getByRole("textbox", { name: "Minute" }).fill("07");
			dialog.getByRole("button", { name: "Save date", exact: true }).element().click();
		});

		expect(writes[1]).toMatchObject({
			method: "PUT",
			path: `${ENTRY_PATH}?locale=en`,
			body: { publishedAt: expect.any(String) },
		});
	});
});
