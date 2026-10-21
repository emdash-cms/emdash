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
	status: "published",
	locale: "en",
	translationGroup: null,
	data: { title: "Draft title" },
	authorId: null,
	primaryBylineId: null,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-03T00:00:00Z",
	publishedAt: "2026-01-01T00:00:00Z",
	scheduledAt: null,
	liveRevisionId: "revision-live",
	draftRevisionId: "revision-draft",
};

const DISCARDED = {
	...ENTRY,
	data: { title: "Live title" },
	updatedAt: "2026-01-04T00:00:00Z",
	draftRevisionId: null,
};

const OTHER = {
	...ENTRY,
	id: "post_b",
	slug: "entry-b",
	status: "draft",
	data: { title: "Other title" },
	updatedAt: "2026-01-02T00:00:00Z",
	publishedAt: null,
	liveRevisionId: null,
	draftRevisionId: null,
};

const PAGE = { ...OTHER, id: "page_c", type: "pages", slug: "page-c" };

const ENTRY_PATH = `/_emdash/api/content/posts/${ENTRY.id}`;

// Shaped like the server's tokens, since the router compares their versions before adopting one.
const ENTRY_REV = btoa(`3:${ENTRY.updatedAt}`);
const DISCARDED_REV = btoa(`4:${DISCARDED.updatedAt}`);
const OTHER_REV = btoa(`2:${OTHER.updatedAt}`);

type Entry = { id: string; type: string };
type Screen = Awaited<ReturnType<typeof render>>;

function entryPath(entry: Entry) {
	return `/_emdash/api/content/${entry.type}/${entry.id}`;
}

function openEntry(router: ReturnType<typeof createAdminRouter>, entry: Entry) {
	return router.navigate({
		to: "/content/$collection/$id",
		params: { collection: entry.type, id: entry.id },
	});
}

/** Holds every discard request from now on until `release`; `answered` settles once one has its response. */
function holdDiscards() {
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
		if (typeof input !== "string" || !input.includes("/discard-draft")) return send(input, init);
		await released;
		const response = await send(input, init);
		answer();
		return response;
	}) as typeof fetch;
	return { release, answered };
}

/** Collects every save sent to `entry` from now on. */
function recordSaves(entry: Entry) {
	const saves: Array<Record<string, unknown>> = [];
	const send = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		if (typeof input === "string" && input.startsWith(entryPath(entry)) && init?.method === "PUT") {
			saves.push(typeof init.body === "string" ? JSON.parse(init.body) : {});
		}
		return send(input, init);
	}) as typeof fetch;
	return saves;
}

async function discardChanges(screen: Screen) {
	screen.getByRole("button", { name: "Discard changes", exact: true }).element().click();
	const dialog = screen.getByRole("dialog", { name: "Discard draft changes?" });
	await expect.element(dialog).toBeVisible();
	dialog.getByRole("button", { name: "Discard changes", exact: true }).element().click();
}

describe.each([
	["the same collection", OTHER],
	["another collection", PAGE],
])("switching to an entry in %s while Discard changes is on its way", (_, other) => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } })
			.on("GET", "/_emdash/api/bylines", { data: { items: [], nextCursor: null } })
			.on("GET", "/_emdash/api/content/posts?", { data: { items: [], nextCursor: null } })
			.on("GET", "/_emdash/api/content/pages?", { data: { items: [], nextCursor: null } })
			.on("GET", entryPath(other), { data: { item: other, _rev: OTHER_REV } })
			.on("PUT", `${entryPath(other)}?locale=en`, { data: { item: other, _rev: OTHER_REV } })
			.on("GET", ENTRY_PATH, { data: { item: ENTRY, _rev: ENTRY_REV } })
			.on("POST", `${ENTRY_PATH}/discard-draft?locale=en`, {
				data: { item: DISCARDED, _rev: DISCARDED_REV },
			});
	});

	afterEach(() => {
		mockFetch.restore();
	});

	/** Discards the first entry's draft and reopens `other`, where `beforeLanding` runs before it lands. */
	async function discardThenSwitch(beforeLanding?: (screen: Screen) => Promise<void>) {
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
		await expect.element(title).toHaveValue("Draft title");

		const discard = holdDiscards();
		await discardChanges(screen);
		await openEntry(router, other);
		await expect.element(title).toHaveValue("Other title");
		await beforeLanding?.(screen);
		discard.release();
		await discard.answered;
		await expect.element(screen.getByText("Changes discarded")).toBeVisible();

		return { queryClient, screen, title };
	}

	it("refreshes the entry whose draft it discarded", async () => {
		const { queryClient } = await discardThenSwitch();

		await expect
			.poll(() => queryClient.getQueryState(["content", "posts", ENTRY.id, { locale: undefined }]))
			.toMatchObject({ isInvalidated: true });
	});

	it("keeps the write token of the entry now open", async () => {
		const saves = recordSaves(other);
		const { screen, title } = await discardThenSwitch();

		await title.fill("Edited other title");
		screen.getByRole("button", { name: "Save", exact: true }).element().click();

		await expect.poll(() => saves.length).toBe(1);
		expect(saves[0]).toMatchObject({ _rev: OTHER_REV });
	});

	it("keeps what the writer typed on the entry now open", async () => {
		const { title } = await discardThenSwitch(async (screen) => {
			await screen
				.getByRole("textbox", { name: "Title", exact: true })
				.fill("Typed while discarding");
		});

		await expect.element(title).toHaveValue("Typed while discarding");
	});
});
