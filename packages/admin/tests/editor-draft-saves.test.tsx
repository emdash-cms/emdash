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
import type {
	AdminManifest,
	ContentItem,
	RevisionListItem,
	RevisionListResponse,
} from "../src/lib/api";
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

function manifest(plugins: AdminManifest["plugins"]): AdminManifest {
	return {
		version: "1.0.0",
		hash: "editor-draft-saves",
		authMode: "passkey",
		collections: {
			posts: {
				label: "Posts",
				labelSingular: "Post",
				supports: ["drafts", "revisions"],
				hasSeo: false,
				fields: { title: { kind: "string", type: "string", label: "Title" } },
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
 * Stages a draft revision on every autosave and, as the server does, deletes the one it
 * replaces when the save asks it to skip a revision.
 */
function createMockServer(plugins: AdminManifest["plugins"]) {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let data: Record<string, unknown> = { title: "Draft title" };
	let draftId = "revision-draft";
	let revisions = [revisionItem("revision-draft", data), revisionItem("revision-old", {})];
	let version = 1;
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
		liveRevisionId: "revision-live",
		draftRevisionId: draftId,
	});

	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		requests.push({ method, url, body });

		if (method === "GET" && url === "/_emdash/api/manifest") {
			return jsonResponse({ data: manifest(plugins) });
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
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1/revisions")) {
			return jsonResponse({ data: { items: revisions, total: revisions.length } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			return jsonResponse({ data: { item: item(), _rev: rev(version) } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/revisions/")) {
			const id = url.slice("/_emdash/api/revisions/".length);
			const revision = revisions.find((candidate) => candidate.id === id);
			return jsonResponse({ data: { item: revision ?? revisionItem(id, data) } });
		}
		if (method === "PUT" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			version++;
			data = (body?.data as Record<string, unknown>) ?? data;
			const replaced = draftId;
			draftId = `revision-autosaved-${version}`;
			revisions = [
				revisionItem(draftId, data),
				...revisions.filter((revision) => !(body?.skipRevision && revision.id === replaced)),
			];
			return jsonResponse({ data: { item: item(), _rev: rev(version) } });
		}

		throw new Error(`Unhandled request: ${method} ${url}`);
	}) as typeof fetch;

	return {
		requests,
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
	await vi.waitFor(() => expect(cachedList(queryClient)).toBeDefined());
	return Object.assign(screen, { queryClient });
}

function cachedList(queryClient: QueryClient) {
	return queryClient.getQueryData<RevisionListResponse>(
		revisionsQueryOptions("posts", "post_1", REVISION_LIST_LIMIT).queryKey,
	);
}

describe("saving editor draft patches", () => {
	let server: ReturnType<typeof createMockServer> | undefined;
	const puts = () => server?.requests.filter((request) => request.method === "PUT") ?? [];

	afterEach(async () => {
		await cleanup();
		server?.restore();
		server = undefined;
	});

	it("keeps the draft a sandboxed patch's first autosave replaces, and not the next one", async () => {
		server = createMockServer(SANDBOXED_PLUGINS);
		const screen = await renderEditPage();

		await screen.getByRole("button", { name: "Translate", exact: true }).click();
		const apply = screen
			.getByRole("dialog", { name: "Review proposed changes" })
			.getByRole("button", { name: "Apply changes", exact: true });
		await expect.element(apply).toBeVisible();
		apply.element().click();

		await vi.waitFor(() => expect(puts()).toHaveLength(1), { timeout: 5000 });
		expect(puts()[0]?.body).toMatchObject({
			data: { title: "Translated title" },
			skipRevision: false,
		});
		await vi.waitFor(() =>
			expect(cachedList(screen.queryClient)?.items.map((item) => item.id)).toEqual(
				server!.revisionIds,
			),
		);
		expect(server.revisionIds).toEqual(["revision-autosaved-2", "revision-draft", "revision-old"]);
		expect(cachedList(screen.queryClient)?.total).toBe(3);

		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Translated, edited");
		await vi.waitFor(() => expect(puts()).toHaveLength(2), { timeout: 5000 });
		expect(puts()[1]?.body).toMatchObject({
			data: { title: "Translated, edited" },
			skipRevision: true,
		});
		await vi.waitFor(() =>
			expect(cachedList(screen.queryClient)?.items.map((item) => item.id)).toEqual([
				"revision-autosaved-3",
				"revision-draft",
				"revision-old",
			]),
		);
		expect(cachedList(screen.queryClient)?.total).toBe(3);
	});
});
