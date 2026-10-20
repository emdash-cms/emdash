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

const CONFLICT = { error: { code: "CONFLICT", message: "This entry changed somewhere else." } };

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

/** Collects the path and `_rev` of every publish request sent from now on. */
function recordPublishes() {
	const requests: Array<{ path: string; _rev: unknown }> = [];
	const send = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		if (typeof input === "string" && input.includes("/publish") && typeof init?.body === "string") {
			requests.push({ path: input, _rev: JSON.parse(init.body)._rev });
		}
		return send(input, init);
	}) as typeof fetch;
	return requests;
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
			.on("GET", `/_emdash/api/content/posts/${ENTRY.id}`, {
				data: { item: ENTRY, _rev: "rev-1" },
			});
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("publishes the entry Publish was clicked on when its save lands after a switch", async () => {
		mockFetch
			.on("PUT", `/_emdash/api/content/posts/${ENTRY.id}?locale=en`, {
				data: { item: { ...ENTRY, data: { title: "Edited title" } }, _rev: "rev-2" },
			})
			.on("POST", `/_emdash/api/content/posts/${ENTRY.id}/publish?locale=en`, {
				data: { item: { ...ENTRY, status: "published" }, _rev: "rev-3" },
			})
			.on("POST", `/_emdash/api/content/posts/${OTHER.id}/publish?locale=en`, CONFLICT, 409);
		const publishes = recordPublishes();
		const { router, screen, title } = await renderEditorFromOther();
		await title.fill("Edited title");

		const save = holdPuts();
		screen.getByRole("button", { name: "Publish now", exact: true }).element().click();
		const confirm = screen.getByRole("dialog", { name: "Publish now?" });
		await expect.element(confirm).toBeVisible();
		confirm.getByRole("button", { name: "Publish now", exact: true }).element().click();
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeVisible();
		await openPost(router, OTHER.id);
		await expect.element(title).toHaveValue("Other title");
		save.release();
		await save.answered;

		await expect.poll(() => publishes.length).toBe(1);
		expect(publishes).toEqual([
			{ path: `/_emdash/api/content/posts/${ENTRY.id}/publish?locale=en`, _rev: "rev-2" },
		]);
	});
});
