import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest, ContentItem } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "publish-race",
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
		data: { title: "Draft title", website: "" },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		publishedAt: "2026-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: "revision-live",
		draftRevisionId: "revision-draft",
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
	onPut?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
	onPublish?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function errorResponse(code: string, message: string, status: number) {
	return jsonResponse({ error: { code, message } }, status);
}

function contentResponse(item: RevisionedContentItem) {
	const { _rev, ...contentItem } = item;
	return jsonResponse({ data: { item: contentItem, _rev } });
}

function createMockServer(options: MockServerOptions = {}) {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let putCount = 0;
	let publishCount = 0;

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
			return contentResponse(makeItem());
		}
		if (method === "GET" && url === "/_emdash/api/revisions/revision-draft") {
			return jsonResponse({
				data: {
					item: {
						id: "revision-draft",
						collection: "posts",
						entryId: "post_1",
						data: { title: "Draft title", website: "" },
						authorId: null,
						createdAt: "2026-01-02T00:00:00Z",
					},
				},
			});
		}
		if (method === "PUT" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			const index = putCount++;
			if (options.onPut) return options.onPut(request, index);
			return contentResponse(makeItem({ _rev: `rev-save-${index + 1}` }));
		}
		if (method === "POST" && url.startsWith("/_emdash/api/content/posts/post_1/publish")) {
			const index = publishCount++;
			if (options.onPublish) return options.onPublish(request, index);
			const savedData = requests.findLast(
				(candidate) => candidate.method === "PUT" && candidate.body?.data,
			)?.body?.data as Record<string, unknown> | undefined;
			return contentResponse(
				makeItem({
					_rev: `rev-publish-${index + 1}`,
					data: savedData ?? { title: "Draft title", website: "" },
					liveRevisionId: "revision-draft",
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

	return { router, TestApp };
}

async function renderEditPage() {
	const { router, TestApp } = buildRouter();
	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	const screen = await render(<TestApp />);
	await expect.element(screen.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
	return screen;
}

function contentMutations(requests: RecordedRequest[]) {
	return requests.filter(
		(request) =>
			request.method === "PUT" || (request.method === "POST" && request.url.includes("/publish")),
	);
}

function deferredResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("ContentEditPage publish and autosave ordering", () => {
	let server: ReturnType<typeof createMockServer> | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		server?.restore();
		server = undefined;
		vi.useRealTimers();
	});

	it("flushes the current payload before publish and cancels the pending debounce", async () => {
		server = createMockServer();
		const screen = await renderEditPage();

		await screen.getByRole("textbox", { name: "Title" }).fill("Latest title");
		await screen.getByRole("button", { name: "Publish", exact: true }).click();
		await vi.advanceTimersByTimeAsync(0);

		const mutations = contentMutations(server.requests);
		expect(mutations.map(({ method }) => method)).toEqual(["PUT", "POST"]);
		expect(mutations[0]?.body).toMatchObject({
			data: { title: "Latest title" },
			_rev: "rev-initial",
		});
		expect(mutations[1]?.body).toEqual({ _rev: "rev-save-1" });

		await vi.advanceTimersByTimeAsync(2500);
		expect(contentMutations(server.requests)).toHaveLength(2);
	});

	it("queues the publish flush behind an in-flight autosave", async () => {
		const autosave = deferredResponse();
		server = createMockServer({
			onPut: (_request, index) => {
				if (index === 0) return autosave.promise;
				return contentResponse(makeItem({ _rev: "rev-flush" }));
			},
		});
		const screen = await renderEditPage();

		const title = screen.getByRole("textbox", { name: "Title" });
		await title.fill("Autosave title");
		await vi.advanceTimersByTimeAsync(2000);
		expect(contentMutations(server.requests)).toHaveLength(1);

		await title.fill("Publish title");
		await screen.getByRole("button", { name: "Publish", exact: true }).click();
		await vi.advanceTimersByTimeAsync(0);
		expect(contentMutations(server.requests)).toHaveLength(1);

		autosave.resolve(contentResponse(makeItem({ _rev: "rev-autosave" })));
		await vi.waitFor(() => {
			expect(contentMutations(server!.requests).map(({ method }) => method)).toEqual([
				"PUT",
				"PUT",
				"POST",
			]);
		});

		const mutations = contentMutations(server.requests);
		expect(mutations[1]?.body).toMatchObject({
			data: { title: "Publish title" },
			_rev: "rev-autosave",
		});
		expect(mutations[2]?.body).toEqual({ _rev: "rev-flush" });
	});

	it.each([
		["network failure", () => Promise.reject(new TypeError("Network unavailable"))],
		["server failure", () => errorResponse("CONTENT_UPDATE_ERROR", "Save failed", 500)],
		["revision conflict", () => errorResponse("CONFLICT", "Content changed", 409)],
	])("does not publish after a %s while flushing", async (_name, failure) => {
		server = createMockServer({ onPut: failure });
		const screen = await renderEditPage();

		await screen.getByRole("textbox", { name: "Title" }).fill("Latest title");
		await screen.getByRole("button", { name: "Publish", exact: true }).click();
		await vi.advanceTimersByTimeAsync(0);

		expect(contentMutations(server.requests).map(({ method }) => method)).toEqual(["PUT"]);
	});

	it("does not save or publish an invalid editor payload", async () => {
		server = createMockServer();
		const screen = await renderEditPage();

		await screen.getByRole("textbox", { name: "Website" }).fill("not a URL");
		await screen.getByRole("button", { name: "Publish", exact: true }).click();
		await vi.advanceTimersByTimeAsync(2500);

		expect(contentMutations(server.requests)).toEqual([]);
	});

	it("coalesces repeated publish clicks and advances the revision token after save and publish", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });
		const publish = screen.getByRole("button", { name: "Publish", exact: true });

		await title.fill("First publish");
		publish.element().click();
		publish.element().click();
		await vi.advanceTimersByTimeAsync(0);
		expect(contentMutations(server.requests).map(({ method }) => method)).toEqual(["PUT", "POST"]);

		await title.fill("After publish");
		await vi.advanceTimersByTimeAsync(2000);
		const mutations = contentMutations(server.requests);
		expect(mutations.map(({ method }) => method)).toEqual(["PUT", "POST", "PUT"]);
		expect(mutations[2]?.body).toMatchObject({ _rev: "rev-publish-1" });
	});

	it("keeps edits made after a coalesced publish click dirty", async () => {
		const save = deferredResponse();
		server = createMockServer({
			onPut: (request, index) => {
				if (index === 0) return save.promise;
				return contentResponse(
					makeItem({
						_rev: "rev-after-publish",
						data: request.body?.data as Record<string, unknown>,
					}),
				);
			},
			onPublish: () =>
				contentResponse(
					makeItem({
						_rev: "rev-published",
						data: { title: "First publish", website: "" },
						liveRevisionId: "revision-draft",
					}),
				),
		});
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });
		const publish = screen.getByRole("button", { name: "Publish", exact: true });

		await title.fill("First publish");
		publish.element().click();
		await vi.waitFor(() => expect(contentMutations(server!.requests)).toHaveLength(1));
		await title.fill("Second edit");
		publish.element().click();

		save.resolve(
			contentResponse(
				makeItem({ _rev: "rev-saved", data: { title: "First publish", website: "" } }),
			),
		);
		await vi.waitFor(() =>
			expect(contentMutations(server!.requests).map(({ method }) => method)).toEqual([
				"PUT",
				"POST",
			]),
		);
		await vi.advanceTimersByTimeAsync(2000);
		await vi.waitFor(() => expect(contentMutations(server!.requests)).toHaveLength(3));

		const mutations = contentMutations(server.requests);
		expect(mutations[2]?.body).toMatchObject({
			data: { title: "Second edit" },
			_rev: "rev-published",
		});
	});

	it("ignores Enter-key form submission while publish is in flight", async () => {
		const publishResponse = deferredResponse();
		server = createMockServer({ onPublish: () => publishResponse.promise });
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("Publish title");
		await screen.getByRole("button", { name: "Publish", exact: true }).click();
		await vi.waitFor(() =>
			expect(contentMutations(server!.requests).map(({ method }) => method)).toEqual([
				"PUT",
				"POST",
			]),
		);

		title.element().focus();
		await userEvent.keyboard("{Enter}");
		await vi.advanceTimersByTimeAsync(0);
		expect(contentMutations(server.requests).map(({ method }) => method)).toEqual(["PUT", "POST"]);

		publishResponse.resolve(contentResponse(makeItem({ _rev: "rev-published" })));
	});
});
