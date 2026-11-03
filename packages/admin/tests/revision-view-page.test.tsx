import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "vitest-browser-react";

import {
	REVISION_LIST_LIMIT,
	revisionsQueryOptions,
} from "../src/components/revisions/revision-query";
import { useRevisionViewContext } from "../src/components/revisions/revision-view-context";
import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest, ContentItem, RevisionListResponse } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

// Stands in for the expanded version list: it keeps the list query open, as the real one does.
function MockRevisionHistory({ collection, entryId }: { collection: string; entryId: string }) {
	const view = useRevisionViewContext();
	useQuery(revisionsQueryOptions(collection, entryId, view?.listLimit ?? REVISION_LIST_LIMIT));
	if (!view) return null;
	return (
		<>
			<button
				type="button"
				onClick={(event) => {
					if (view.currentRevisionId)
						view.view(view.currentRevisionId, { opener: event.currentTarget });
				}}
			>
				View the current version
			</button>
			<button
				type="button"
				onClick={(event) => view.view("revision-old", { opener: event.currentTarget })}
			>
				View the old version
			</button>
		</>
	);
}

vi.mock("../src/components/RevisionHistory", () => ({
	RevisionHistory: (props: { collection: string; entryId: string }) => (
		<MockRevisionHistory {...props} />
	),
}));

vi.mock("../src/components/revisions/RevisionViewCanvas", () => ({
	RevisionViewCanvas: ({ label }: { label: string }) => <article aria-label={label} />,
}));

vi.mock("../src/lib/revision-diff/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/revision-diff/index.js")>()),
	diffVersion: vi.fn(() => ({ hasPrevious: true, fields: [], slug: null, changes: [] })),
}));

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "revision-restore",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
			hasSeo: false,
			fields: {
				title: { kind: "string", label: "Title" },
				content: { kind: "portableText", label: "Content" },
			},
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

function textBlocks(text: string) {
	return [
		{
			_type: "block",
			_key: "b1",
			style: "normal",
			markDefs: [],
			children: [{ _type: "span", _key: "s1", text, marks: [] }],
		},
	];
}

const DRAFT_DATA = { title: "Draft title", content: textBlocks("Draft body") };
const OLD_DATA = { title: "Old title", content: textBlocks("Old body") };
const DRAFT_INTERNALS = { _references: { related: ["tg_1"] } };

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "post_1",
		type: "posts",
		slug: "post-one",
		status: "published",
		locale: "en",
		translationGroup: null,
		data: DRAFT_DATA,
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		publishedAt: "2026-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: "revision-live",
		draftRevisionId: "revision-draft",
		...overrides,
	};
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** A `_rev` encoded like the server's, so the client can tell which is newer. */
function rev(version: number) {
	return btoa(`${version}:2026-01-02T00:00:00Z`);
}

function revisionResponse(id: string, data: Record<string, unknown>) {
	return jsonResponse({
		data: {
			item: {
				id,
				collection: "posts",
				entryId: "post_1",
				data,
				authorId: null,
				createdAt: "2026-01-02 00:00:00",
			},
		},
	});
}

interface RecordedRequest {
	method: string;
	url: string;
	body?: Record<string, unknown>;
}

function createMockServer() {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let restored = false;
	let draftId = "revision-draft";
	let autosaves = 0;
	let version = 1;
	let releaseRestoredEntry = () => {};
	const restoredEntryReleased = new Promise<void>((resolve) => {
		releaseRestoredEntry = resolve;
	});
	// One-shot gates: the next list read, entry read or save waits until its gate is released.
	const gates = {
		list: [] as Promise<void>[],
		entry: [] as Promise<void>[],
		autosave: [] as Promise<void>[],
	};
	function hold(kind: keyof typeof gates) {
		let release = () => {};
		gates[kind].push(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		return release;
	}

	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		requests.push({ method, url, body });

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
		if (url.startsWith("/_emdash/api/content/posts/post_1/lock")) {
			return jsonResponse({ data: { enabled: false, holder: null, heldByCaller: false } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1/revisions")) {
			const gate = gates.list.shift();
			// The list as the server holds it when the read arrives.
			const response = jsonResponse({
				data: {
					items: [
						{
							id: draftId,
							collection: "posts",
							entryId: "post_1",
							data: restored ? OLD_DATA : DRAFT_DATA,
							authorId: null,
							author: null,
							createdAt: "2026-01-02 00:00:00",
						},
						{
							id: "revision-old",
							collection: "posts",
							entryId: "post_1",
							data: OLD_DATA,
							authorId: null,
							author: null,
							createdAt: "2026-01-01 00:00:00",
						},
					],
					total: 2,
				},
			});
			await gate;
			return response;
		}
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			if (!restored) {
				const gate = gates.entry.shift();
				const response = jsonResponse({ data: { item: makeItem(), _rev: rev(1) } });
				await gate;
				return response;
			}
			await restoredEntryReleased;
			// Like the server, the entry read carries its draft revision's data.
			const item = makeItem({ draftRevisionId: "revision-restored", data: OLD_DATA });
			return jsonResponse({ data: { item, _rev: rev(version) } });
		}
		if (method === "GET" && url === "/_emdash/api/revisions/revision-draft") {
			return revisionResponse("revision-draft", { ...DRAFT_DATA, ...DRAFT_INTERNALS });
		}
		if (method === "GET" && url === "/_emdash/api/revisions/revision-restored") {
			return revisionResponse("revision-restored", OLD_DATA);
		}
		if (method === "PUT" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			await gates.autosave.shift();
			autosaves++;
			version++;
			draftId = `revision-autosaved-${autosaves}`;
			// A draft autosave leaves the entry's updatedAt where it was.
			const item = makeItem({
				draftRevisionId: draftId,
				data: body?.data as Record<string, unknown>,
			});
			return jsonResponse({ data: { item, _rev: rev(version) } });
		}
		if (method === "POST" && url === "/_emdash/api/revisions/revision-old/restore") {
			restored = true;
			version++;
			draftId = "revision-restored";
			const item = makeItem({ draftRevisionId: "revision-restored", data: OLD_DATA });
			return jsonResponse({ data: { item, _rev: rev(version) } });
		}

		throw new Error(`Unhandled request: ${method} ${url}`);
	}) as typeof fetch;

	return {
		requests,
		releaseRestoredEntry,
		holdNextListRead: () => hold("list"),
		holdNextEntryRead: () => hold("entry"),
		holdNextAutosave: () => hold("autosave"),
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

async function renderEditPage(seed?: (queryClient: QueryClient) => void) {
	const queryClient = createTestQueryClient();
	// As in the app, so a list read once stays fresh for a minute.
	queryClient.setQueryDefaults(["revisions"], { staleTime: 60_000 });
	queryClient.setQueryDefaults(["content"], { gcTime: 60_000 });
	seed?.(queryClient);
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

	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	const screen = await render(<TestApp />);
	await expect
		.element(screen.getByRole("textbox", { name: "Title", exact: true }))
		.toHaveValue("Draft title");
	return Object.assign(screen, { queryClient });
}

function cachedList(queryClient: QueryClient) {
	return queryClient.getQueryData<RevisionListResponse>(
		revisionsQueryOptions("posts", "post_1", REVISION_LIST_LIMIT).queryKey,
	);
}

function bodyEditor() {
	return document.querySelector<HTMLElement>("#field-content .ProseMirror");
}

function versionView() {
	return document.querySelector("article[aria-label^='Version from']");
}

const TODAY = /^Today, /;

describe("ContentEditPage revision view", () => {
	let server: ReturnType<typeof createMockServer> | undefined;
	const listReads = () =>
		server?.requests.filter(
			(request) => request.method === "GET" && request.url.includes("/post_1/revisions"),
		) ?? [];

	afterEach(async () => {
		await cleanup();
		server?.restore();
		server = undefined;
	});

	it("keeps the restore pending until the editor holds the restored version", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Draft body"));

		await screen.getByRole("button", { name: "View the old version" }).click();
		await screen.getByRole("button", { name: "Restore", exact: true }).click();
		const dialog = screen.getByRole("dialog", { name: "Restore this version?" });
		dialog.getByRole("button", { name: "Restore", exact: true }).element().click();

		await vi.waitFor(() =>
			expect(server?.requests).toContainEqual({
				method: "POST",
				url: "/_emdash/api/revisions/revision-old/restore",
			}),
		);
		await expect.element(dialog.getByRole("button", { name: "Restoring…" })).toBeDisabled();
		expect(versionView()).not.toBeNull();
		expect(bodyEditor()?.textContent).toBe("Draft body");

		server.releaseRestoredEntry();
		await vi.waitFor(() => expect(versionView()).toBeNull());
		await expect
			.element(screen.getByRole("textbox", { name: "Title", exact: true }))
			.toHaveValue("Old title");
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Old body"));
		await expect.element(screen.getByText("Version restored")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "View the old version" }))
			.toHaveFocus();
	});
	it("follows the autosave it sent on the way in to the new current version, dated now", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		await vi.waitFor(() => expect(listReads()).toHaveLength(1));
		const releaseAutosave = server.holdNextAutosave();
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Typed before viewing");
		await screen.getByRole("button", { name: "View the current version" }).click();
		const title = screen.getByRole("heading", { level: 2 });
		await expect.element(title).toBeVisible();
		await vi.waitFor(() =>
			expect(server?.requests.filter((request) => request.method === "PUT")).toHaveLength(1),
		);
		expect(title.element().textContent).not.toMatch(TODAY);

		releaseAutosave();
		await expect.element(title).toHaveTextContent(TODAY);
		await expect.element(screen.getByText("Current version", { exact: true })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Back to editing" })).toBeVisible();
		expect(document.body.textContent).not.toContain("no longer available");
		expect(listReads()).toHaveLength(1);
	});

	it("reads the versions again when a view opens after an autosave, not for the open list", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		await vi.waitFor(() => expect(listReads()).toHaveLength(1));
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Typed and autosaved");
		await vi.waitFor(
			() => expect(cachedList(screen.queryClient)?.items[0]?.id).toBe("revision-autosaved-1"),
			{ timeout: 5000 },
		);
		expect(listReads()).toHaveLength(1);

		await screen.getByRole("button", { name: "View the current version" }).click();
		await expect.element(screen.getByRole("button", { name: "Back to editing" })).toBeVisible();
		await vi.waitFor(() => expect(listReads()).toHaveLength(2));
	});

	it("patches the open list the way the server writes the autosaved draft", async () => {
		server = createMockServer();
		const screen = await renderEditPage((queryClient) => {
			// Another view of the same entry, read before its current draft was written.
			queryClient.setQueryData(
				["content", "posts", "post_1", "calendar"],
				makeItem({ draftRevisionId: "revision-stale" }),
			);
		});
		await vi.waitFor(() => expect(cachedList(screen.queryClient)).toBeDefined());
		const sent = Date.now();
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Typed and autosaved");
		await vi.waitFor(
			() => expect(cachedList(screen.queryClient)?.items[0]?.id).toBe("revision-autosaved-1"),
			{ timeout: 5000 },
		);

		const list = cachedList(screen.queryClient)!;
		expect(list.items.map((item) => item.id)).toEqual(["revision-autosaved-1", "revision-old"]);
		expect(list.total).toBe(2);
		expect(list.items[0]?.data).toMatchObject({
			title: "Typed and autosaved",
			...DRAFT_INTERNALS,
		});
		expect(Date.parse(list.items[0]!.createdAt)).toBeGreaterThanOrEqual(sent);
	});
	it("keeps an autosave's draft in the list when a read sent before it lands after it", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title", exact: true });
		await title.fill("First edit");
		await vi.waitFor(
			() => expect(cachedList(screen.queryClient)?.items[0]?.id).toBe("revision-autosaved-1"),
			{ timeout: 5000 },
		);

		const releaseAutosave = server.holdNextAutosave();
		const releaseRead = server.holdNextListRead();
		await title.fill("Second edit");
		await screen.getByRole("button", { name: "View the current version" }).click();
		await vi.waitFor(() => expect(listReads()).toHaveLength(2));
		releaseAutosave();
		await vi.waitFor(() =>
			expect(cachedList(screen.queryClient)?.items[0]?.id).toBe("revision-autosaved-2"),
		);
		releaseRead();

		await vi.waitFor(() => expect(listReads()).toHaveLength(3));
		await expect.element(screen.getByText("Current version", { exact: true })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Back to editing" })).toBeVisible();
		const list = cachedList(screen.queryClient)!;
		expect(list.items.map((item) => item.id)).toEqual(["revision-autosaved-2", "revision-old"]);
		expect(list.total).toBe(2);
	});

	it("replaces the draft a save just wrote while the entry is still being read again", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		await vi.waitFor(() => expect(listReads()).toHaveLength(1));
		const title = screen.getByRole("textbox", { name: "Title", exact: true });
		const releaseEntryRead = server.holdNextEntryRead();
		await title.fill("Saved by hand");
		await screen.getByRole("button", { name: "Save" }).click();
		await vi.waitFor(() =>
			expect(cachedList(screen.queryClient)?.items[0]?.id).toBe("revision-autosaved-1"),
		);

		await title.fill("Typed after saving");
		await vi.waitFor(
			() => expect(cachedList(screen.queryClient)?.items[0]?.id).toBe("revision-autosaved-2"),
			{ timeout: 5000 },
		);
		const list = cachedList(screen.queryClient)!;
		expect(list.items.map((item) => item.id)).toEqual(["revision-autosaved-2", "revision-old"]);
		expect(list.total).toBe(2);
		releaseEntryRead();
	});

	it("reads the list again when an autosave lands during its first read", async () => {
		server = createMockServer();
		const releaseRead = server.holdNextListRead();
		const screen = await renderEditPage();
		await vi.waitFor(() => expect(listReads()).toHaveLength(1));
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Typed while it loads");
		await vi.waitFor(
			() => expect(server?.requests.filter((request) => request.method === "PUT")).toHaveLength(1),
			{ timeout: 5000 },
		);
		await vi.waitFor(() => expect(listReads()).toHaveLength(2));
		releaseRead();

		await vi.waitFor(() =>
			expect(cachedList(screen.queryClient)?.items.map((item) => item.id)).toEqual([
				"revision-autosaved-1",
				"revision-old",
			]),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(cachedList(screen.queryClient)?.items[0]?.id).toBe("revision-autosaved-1");
	});
});
