import { Toasty } from "@cloudflare/kumo";
import type { EditorDraftPatchOperation } from "@emdash-cms/blocks";
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
import type {
	AdminManifest,
	ContentItem,
	ContentSeo,
	RevisionListItem,
	RevisionListResponse,
} from "../src/lib/api";
import type {
	ContentEditorDraft,
	ContentEditorPanelContext,
} from "../src/lib/content-editor-panels";
import { PluginAdminProvider, type PluginAdmins } from "../src/lib/plugin-context";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

// Keeps the version list query open, as the expanded list does.
function MockRevisionHistory({ collection, entryId }: { collection: string; entryId: string }) {
	const view = useRevisionViewContext();
	useQuery(revisionsQueryOptions(collection, entryId, view?.listLimit ?? REVISION_LIST_LIMIT));
	return null;
}

vi.mock("../src/components/RevisionHistory", () => ({
	RevisionHistory: (props: { collection: string; entryId: string }) => (
		<MockRevisionHistory {...props} />
	),
}));

let panelDraft: ContentEditorDraft | undefined;

function DraftToolsPanel({ editorDraft }: ContentEditorPanelContext) {
	panelDraft = editorDraft;
	return <p data-testid="draft-tools">Draft tools</p>;
}

const PLUGIN_ADMINS: PluginAdmins = {
	drafts: {
		contentEditorPanels: [{ id: "draft-tools", title: "Draft tools", component: DraftToolsPanel }],
	},
};

const TRUSTED_PLUGINS: AdminManifest["plugins"] = { drafts: { enabled: true } };

const SANDBOXED_PLUGINS: AdminManifest["plugins"] = {
	translator: {
		enabled: true,
		adminMode: "blocks",
		editorActions: [
			{
				id: "translate",
				label: "Translate",
				route: "translate",
				placement: "toolbar",
				draft: { read: { fields: ["title"] }, patch: { fields: ["title"] } },
			},
		],
	},
};

function manifest(plugins: AdminManifest["plugins"], hasSeo: boolean): AdminManifest {
	return {
		version: "1.0.0",
		hash: "editor-draft-saves",
		authMode: "passkey",
		collections: {
			posts: {
				label: "Posts",
				labelSingular: "Post",
				supports: ["drafts", "revisions"],
				hasSeo,
				fields: {
					title: { kind: "string", type: "string", label: "Title" },
					summary: { kind: "richText", type: "text", label: "Summary" },
				},
			},
		},
		plugins,
		taxonomies: [],
		i18n: undefined,
	};
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function rev(version: number) {
	return btoa(`${version}:2026-01-02T00:00:00Z`);
}

function revisionItem(id: string, data: Record<string, unknown>): RevisionListItem {
	return {
		id,
		collection: "posts",
		entryId: "post_1",
		data,
		authorId: null,
		author: null,
		createdAt: "2026-01-02 00:00:00",
	};
}

interface RecordedRequest {
	method: string;
	url: string;
	body?: Record<string, unknown>;
}

/**
 * Stages a draft revision on every content save and, as the server does, deletes the one it
 * replaces when the save asks it to skip a revision. The next content save or publish can be
 * held until the test releases it.
 */
function createMockServer({
	plugins = TRUSTED_PLUGINS,
	hasSeo = false,
}: { plugins?: AdminManifest["plugins"]; hasSeo?: boolean } = {}) {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let data: Record<string, unknown> = { title: "Draft title", summary: "Draft summary" };
	let seo: ContentSeo = {
		title: null,
		description: null,
		image: null,
		canonical: null,
		noIndex: false,
	};
	let draftId = "revision-draft";
	let liveId = "revision-live";
	let revisions = [revisionItem("revision-draft", data), revisionItem("revision-old", {})];
	let version = 1;
	const gates = { put: [] as Promise<void>[], publish: [] as Promise<void>[] };
	function hold(kind: keyof typeof gates) {
		let release = () => {};
		gates[kind].push(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		return release;
	}
	const item = (): ContentItem => ({
		id: "post_1",
		type: "posts",
		slug: "post-one",
		status: "published",
		locale: "en",
		translationGroup: null,
		data,
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		publishedAt: "2026-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: liveId,
		draftRevisionId: draftId,
		seo,
	});
	const entryResponse = () => jsonResponse({ data: { item: item(), _rev: rev(version) } });

	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		requests.push({ method, url, body });

		if (method === "GET" && url === "/_emdash/api/manifest") {
			return jsonResponse({ data: manifest(plugins, hasSeo) });
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
		if (method === "POST" && url.includes("/plugin-extensions/translator/action/translate")) {
			const draft = body?.draft as Record<string, unknown>;
			return jsonResponse({
				data: {
					patch: {
						type: "editor-draft-patch",
						operations: [{ op: "set", field: "title", value: "Translated title" }],
					},
					editorInvocation: {
						entryId: draft.entryId,
						locale: draft.locale,
						baseRevision: draft.baseRevision,
						generation: draft.generation,
						invocationId: draft.invocationId,
						fieldDefinitions: [
							{
								slug: "title",
								label: "Title",
								type: "string",
								required: false,
								translatable: false,
							},
						],
					},
				},
			});
		}
		if (method === "POST" && url.startsWith("/_emdash/api/content/posts/post_1/publish")) {
			await gates.publish.shift();
			version++;
			liveId = draftId;
			return entryResponse();
		}
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1/revisions")) {
			return jsonResponse({ data: { items: revisions, total: revisions.length } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			return entryResponse();
		}
		if (method === "GET" && url.startsWith("/_emdash/api/revisions/")) {
			const id = url.slice("/_emdash/api/revisions/".length);
			const revision = revisions.find((candidate) => candidate.id === id);
			return jsonResponse({ data: { item: revision ?? revisionItem(id, data) } });
		}
		if (method === "PUT" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			await gates.put.shift();
			version++;
			if (body?.seo) seo = { ...seo, ...(body.seo as Partial<ContentSeo>) };
			if (body?.data) {
				data = body.data as Record<string, unknown>;
				const replaced = draftId;
				draftId = `revision-saved-${version}`;
				revisions = [
					revisionItem(draftId, data),
					...revisions.filter(
						(revision) => !(body.skipRevision && revision.id === replaced && replaced !== liveId),
					),
				];
			}
			return entryResponse();
		}

		throw new Error(`Unhandled request: ${method} ${url}`);
	}) as typeof fetch;

	return {
		requests,
		holdNextPut: () => hold("put"),
		holdNextPublish: () => hold("publish"),
		get revisionIds() {
			return revisions.map((revision) => revision.id);
		},
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

async function renderEditPage() {
	const queryClient = createTestQueryClient();
	queryClient.setQueryDefaults(["revisions"], { staleTime: 60_000 });
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });

	function TestApp() {
		return (
			<I18nProvider i18n={i18n}>
				<ThemeProvider defaultTheme="light">
					<Toasty>
						<QueryClientProvider client={queryClient}>
							<PluginAdminProvider pluginAdmins={PLUGIN_ADMINS}>
								<RouterProvider router={router} />
							</PluginAdminProvider>
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
	await vi.waitFor(() => expect(cachedList(queryClient)).toBeDefined());
	return Object.assign(screen, { queryClient });
}

function cachedList(queryClient: QueryClient) {
	return queryClient.getQueryData<RevisionListResponse>(
		revisionsQueryOptions("posts", "post_1", REVISION_LIST_LIMIT).queryKey,
	);
}

function patchDraft(operations: EditorDraftPatchOperation[]) {
	if (!panelDraft) throw new Error("The trusted panel has no editorDraft");
	return panelDraft.patch(operations, { expectedRevision: panelDraft.get().revision });
}

describe("saving editor draft patches", () => {
	let server: ReturnType<typeof createMockServer> | undefined;
	const requests = (method: string, has: (body: Record<string, unknown>) => boolean = () => true) =>
		server?.requests.filter(
			(request) =>
				request.method === method &&
				request.url.startsWith("/_emdash/api/content/posts/post_1") &&
				has(request.body ?? {}),
		) ?? [];
	const contentPuts = () => requests("PUT", (body) => body.data !== undefined);

	afterEach(async () => {
		await cleanup();
		server?.restore();
		server = undefined;
		panelDraft = undefined;
	});

	it("keeps the draft a sandboxed patch's first autosave replaces, and not the next one", async () => {
		server = createMockServer({ plugins: SANDBOXED_PLUGINS });
		const screen = await renderEditPage();

		await screen.getByRole("button", { name: "Translate", exact: true }).click();
		const apply = screen
			.getByRole("dialog", { name: "Review proposed changes" })
			.getByRole("button", { name: "Apply changes", exact: true });
		await expect.element(apply).toBeVisible();
		apply.element().click();

		await vi.waitFor(() => expect(contentPuts()).toHaveLength(1), { timeout: 5000 });
		expect(contentPuts()[0]?.body).toMatchObject({
			data: { title: "Translated title" },
			skipRevision: false,
		});
		await vi.waitFor(() =>
			expect(cachedList(screen.queryClient)?.items.map((item) => item.id)).toEqual(
				server!.revisionIds,
			),
		);
		expect(server.revisionIds).toEqual(["revision-saved-2", "revision-draft", "revision-old"]);
		expect(cachedList(screen.queryClient)?.total).toBe(3);

		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Translated, edited");
		await vi.waitFor(() => expect(contentPuts()).toHaveLength(2), { timeout: 5000 });
		expect(contentPuts()[1]?.body).toMatchObject({
			data: { title: "Translated, edited" },
			skipRevision: true,
		});
		await vi.waitFor(() =>
			expect(cachedList(screen.queryClient)?.items.map((item) => item.id)).toEqual([
				"revision-saved-3",
				"revision-draft",
				"revision-old",
			]),
		);
		expect(cachedList(screen.queryClient)?.total).toBe(3);
	});

	it("keeps the revision written by an autosave that was in flight when a patch applied", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		const release = server.holdNextPut();

		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Typed title");
		await vi.waitFor(() => expect(contentPuts()).toHaveLength(1), { timeout: 5000 });
		expect(patchDraft([{ op: "set", field: "summary", value: "Patched summary" }])).toEqual({
			ok: true,
		});
		release();

		await vi.waitFor(() => expect(contentPuts()).toHaveLength(2), { timeout: 5000 });
		expect(contentPuts().map((request) => request.body)).toMatchObject([
			{ data: { title: "Typed title", summary: "Draft summary" }, skipRevision: true },
			{ data: { title: "Typed title", summary: "Patched summary" }, skipRevision: false },
		]);
		expect(server.revisionIds).toEqual(["revision-saved-3", "revision-saved-2", "revision-old"]);
		await vi.waitFor(() =>
			expect(cachedList(screen.queryClient)?.items.map((item) => item.id)).toEqual(
				server!.revisionIds,
			),
		);
	});

	it("keeps a patch made while a manual save is in flight through its reload, and saves it", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Saved title");
		const release = server.holdNextPut();
		await screen.getByRole("button", { name: "Save", exact: true }).click();
		await vi.waitFor(() => expect(contentPuts()).toHaveLength(1));

		expect(patchDraft([{ op: "set", field: "summary", value: "Patched summary" }])).toEqual({
			ok: true,
		});
		release();

		await vi.waitFor(() => expect(contentPuts()).toHaveLength(2), { timeout: 5000 });
		expect(contentPuts()[1]?.body).toMatchObject({
			data: { title: "Saved title", summary: "Patched summary" },
			skipRevision: false,
		});
		await expect
			.element(screen.getByRole("textbox", { name: "Summary", exact: true }))
			.toHaveValue("Patched summary");
	});

	it("keeps a patch made while a publish is in flight, and saves it afterwards", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Published title");
		const release = server.holdNextPublish();
		await screen.getByRole("button", { name: "Publish changes", exact: true }).click();
		const confirm = screen
			.getByRole("dialog", { name: "Publish changes?" })
			.getByRole("button", { name: "Publish changes", exact: true });
		await expect.element(confirm).toBeVisible();
		confirm.element().click();
		await vi.waitFor(() => expect(requests("POST")).toHaveLength(1), { timeout: 5000 });

		expect(patchDraft([{ op: "set", field: "summary", value: "Patched summary" }])).toEqual({
			ok: true,
		});
		release();

		await vi.waitFor(() => expect(contentPuts()).toHaveLength(2), { timeout: 5000 });
		expect(contentPuts()[1]?.body).toMatchObject({
			data: { title: "Published title", summary: "Patched summary" },
		});
		await expect
			.element(screen.getByRole("textbox", { name: "Summary", exact: true }))
			.toHaveValue("Patched summary");
	});

	it("sends a seo.title-only patch as an SEO save, with no content save", async () => {
		server = createMockServer({ hasSeo: true });
		await renderEditPage();

		expect(patchDraft([{ op: "set", field: "seo.title", value: "Hola" }])).toEqual({ ok: true });

		await vi.waitFor(() => expect(requests("PUT")).toHaveLength(1));
		expect(requests("PUT")[0]?.body).toMatchObject({
			seo: { title: "Hola", description: null, canonical: null, noIndex: false },
		});
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(contentPuts()).toHaveLength(0);
	});

	it("saves the fields and the SEO text of one patch in two requests", async () => {
		server = createMockServer({ hasSeo: true });
		const screen = await renderEditPage();

		expect(
			patchDraft([
				{ op: "set", field: "summary", value: "Resumen" },
				{ op: "set", field: "seo.title", value: "Hola" },
			]),
		).toEqual({ ok: true });

		await vi.waitFor(
			() => {
				expect(requests("PUT", (body) => body.seo !== undefined)).toHaveLength(1);
				expect(contentPuts()).toHaveLength(1);
			},
			{ timeout: 8000 },
		);
		expect(requests("PUT", (body) => body.seo !== undefined)[0]?.body).toMatchObject({
			seo: { title: "Hola" },
		});
		expect(contentPuts()[0]?.body).toMatchObject({
			data: { summary: "Resumen" },
			skipRevision: false,
		});
		await expect.element(screen.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
	});
});
