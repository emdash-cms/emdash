import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider, RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentEditor } from "../src/components/ContentEditor";
import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest, ContentItem } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "rev-lockout",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
			hasSeo: true,
			fields: {
				title: { kind: "string", label: "Title" },
				link: { kind: "url", label: "Link" },
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
		data: { title: "Draft title" },
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

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function contentResponse(item: RevisionedContentItem) {
	const { _rev, ...contentItem } = item;
	return jsonResponse({ data: { item: contentItem, _rev } });
}

function createServer() {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let version = 1;
	let current = makeItem({
		status: "draft",
		liveRevisionId: null,
		draftRevisionId: null,
		_rev: revision(version),
		updatedAt: "2026-01-01T00:00:00Z",
	});
	let pendingRead: ((response: Response) => void) | undefined;
	let delayNextRead = false;
	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		requests.push({ method, url, body });
		if (url === "/_emdash/api/manifest") return jsonResponse({ data: MANIFEST });
		if (url === "/_emdash/api/auth/me") return jsonResponse({ data: { id: "user_1", role: 40 } });
		if (url.startsWith("/_emdash/api/bylines") || url.startsWith("/_emdash/api/users"))
			return jsonResponse({ data: { items: [] } });
		if (url === "/_emdash/api/revisions/revision-current")
			return jsonResponse({
				data: {
					item: {
						id: "revision-current",
						collection: "posts",
						entryId: "post_1",
						data: current.data,
						authorId: null,
						createdAt: "2026-01-02T00:00:00Z",
					},
				},
			});
		if (url.startsWith("/_emdash/api/revisions") || url.includes("/post_1/revisions")) {
			if (method === "POST") {
				version++;
				current = { ...current, data: { title: "Restored title" }, _rev: revision(version) };
				return contentResponse(current);
			}
			return jsonResponse({
				data: {
					items: [
						{
							id: "revision-current",
							collection: "posts",
							entryId: "post_1",
							data: current.data,
							authorId: null,
							createdAt: "2026-01-02T00:00:00Z",
						},
						{
							id: "revision-old",
							collection: "posts",
							entryId: "post_1",
							data: { title: "Restored title" },
							authorId: null,
							createdAt: "2026-01-01T00:00:00Z",
						},
					],
					total: 2,
				},
			});
		}
		if (url.startsWith("/_emdash/api/content/posts/post_1")) {
			if (method === "POST" && url.includes("/discard-draft")) {
				version++;
				current = {
					...current,
					data: { title: "Published title" },
					draftRevisionId: null,
					_rev: revision(version),
				};
				return contentResponse(current);
			}
			if (method === "GET") {
				if (delayNextRead) {
					delayNextRead = false;
					return new Promise<Response>((resolve) => {
						pendingRead = resolve;
					});
				}
				return contentResponse(current);
			}
			if (method === "PUT") {
				if (body._rev !== current._rev)
					return jsonResponse(
						{
							error: {
								code: "CONFLICT",
								message: "Content has been modified since last read (version conflict)",
							},
						},
						409,
					);
				version++;
				current = {
					...current,
					...body,
					_rev: revision(version),
					updatedAt: `2026-01-0${version}T00:00:00Z`,
				};
				return contentResponse(current);
			}
		}
		throw new Error(`Unhandled request: ${method} ${url}`);
	}) as typeof fetch;
	return {
		requests,
		publishWithDraft() {
			current = {
				...current,
				status: "published",
				liveRevisionId: "revision-live",
				draftRevisionId: "revision-current",
			};
		},
		get current() {
			return current;
		},
		advance(data = { title: "Newer server title" }) {
			version++;
			current = {
				...current,
				data,
				_rev: revision(version),
				updatedAt: `2026-01-0${version}T00:00:00Z`,
			};
		},
		delayRead() {
			delayNextRead = true;
		},
		resolveRead(item = current) {
			pendingRead!(contentResponse(item));
			pendingRead = undefined;
		},
		get readPending() {
			return !!pendingRead;
		},
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

function revision(version: number) {
	return btoa(`${version}:2026-01-01T00:00:00Z`);
}

async function renderEditPage(cachedItem?: RevisionedContentItem) {
	const queryClient = createTestQueryClient();
	queryClient.setQueryDefaults(["content"], { gcTime: 60_000 });
	if (cachedItem)
		queryClient.setQueryData(["content", "posts", "post_1", { locale: undefined }], cachedItem);
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
	const title = screen.getByRole("textbox", { name: "Title", exact: true });
	await expect.element(title).toBeVisible();
	await expect.element(title).toHaveValue("Draft title");
	return { screen, queryClient };
}

describe("ContentEditPage background reads with the real editor", () => {
	let server: ReturnType<typeof createServer>;
	beforeEach(() => {
		vi.useFakeTimers();
		server = createServer();
	});
	afterEach(() => {
		server.restore();
		vi.useRealTimers();
	});

	it.each(["entry", "locale"])(
		"resets a dirty form when its %s identity changes",
		async (identity) => {
			const initial = server.current;
			const onSave = vi.fn();
			const router = createAdminRouter(createTestQueryClient());
			function editor(item: ContentItem) {
				return (
					<Toasty>
						<RouterContextProvider router={router}>
							<ContentEditor
								collection="posts"
								collectionLabel="Post"
								fields={MANIFEST.collections.posts!.fields}
								item={item}
								onSave={onSave}
							/>
						</RouterContextProvider>
					</Toasty>
				);
			}
			const screen = await render(editor(initial));
			const title = screen.getByRole("textbox", { name: "Title", exact: true });
			await title.fill("Unsaved old entry");
			const next = {
				...initial,
				data: { title: "Other entry" },
				...(identity === "entry" ? { id: "post_2" } : { locale: "fr" }),
			};
			await screen.rerender(editor(next));
			await expect.element(title).toHaveValue("Other entry");
			await expect
				.element(screen.getByRole("button", { name: "Saved", exact: true }))
				.toBeDisabled();
			await title.fill("Edited other entry");
			await vi.advanceTimersByTimeAsync(150);
			await screen.getByRole("button", { name: "Save", exact: true }).click();
			expect(onSave.mock.calls[0]?.[0]).toMatchObject({ data: { title: "Edited other entry" } });
		},
	);

	it.each(["discard", "restore"])("replaces unsaved edits after an explicit %s", async (action) => {
		vi.useRealTimers();
		if (action === "discard") server.publishWithDraft();
		const { screen } = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title", exact: true });
		await title.fill("Unsaved copy to replace");
		if (action === "discard") {
			await screen.getByRole("button", { name: "Discard changes", exact: true }).click();
			await screen
				.getByRole("dialog", { name: "Discard draft changes?" })
				.getByRole("button", { name: "Discard changes", exact: true })
				.element()
				.click();
		} else {
			await screen.getByRole("button", { name: "Revisions", exact: true }).click();
			await screen.getByRole("button", { name: "Restore this version", exact: true }).click();
			await screen
				.getByRole("dialog", { name: "Restore Revision?" })
				.getByRole("button", { name: "Restore", exact: true })
				.element()
				.click();
		}
		await expect
			.element(title)
			.toHaveValue(action === "discard" ? "Published title" : "Restored title");
		await expect.element(screen.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
	});

	it("adopts a fresh revision in a clean cached editor before saving SEO", async () => {
		const cached = server.current;
		server.advance();
		server.delayRead();
		const { screen } = await renderEditPage(cached);
		await vi.waitFor(() => expect(server.readPending).toBe(true));
		server.resolveRead();
		await vi.advanceTimersByTimeAsync(0);
		await expect
			.element(screen.getByRole("textbox", { name: "Title", exact: true }))
			.toHaveValue("Newer server title");
		await screen.getByRole("switch", { name: "Hide from search engines" }).click();
		await vi.advanceTimersByTimeAsync(0);
		expect(server.requests.find((r) => r.method === "PUT")?.body).toMatchObject({
			seo: { noIndex: true },
			_rev: revision(2),
		});
		expect(server.current.seo?.noIndex).toBe(true);
		expect(screen.getByRole("button", { name: "Save anyway", exact: true }).query()).toBeNull();
	});

	it("keeps the successful write token when a delayed stale read completes", async () => {
		const { screen, queryClient } = await renderEditPage();
		const stale = server.current;
		await screen.getByRole("switch", { name: "Hide from search engines" }).click();
		await vi.advanceTimersByTimeAsync(0);
		expect(server.current._rev).toBe(revision(2));
		server.delayRead();
		const read = queryClient.refetchQueries({ queryKey: ["content", "posts", "post_1"] });
		await vi.waitFor(() => expect(server.readPending).toBe(true));
		server.resolveRead(stale);
		await read;
		await vi.advanceTimersByTimeAsync(0);
		await screen.getByRole("switch", { name: "Hide from search engines" }).click();
		await vi.advanceTimersByTimeAsync(0);
		expect(server.requests.findLast((r) => r.method === "PUT")?.body).toMatchObject({
			_rev: revision(2),
		});
		expect(server.current._rev).toBe(revision(3));
		expect(screen.getByRole("button", { name: "Save anyway", exact: true }).query()).toBeNull();
	});

	it.each([false, true])(
		"retains unsaved edits and conflicts on save (batched read: %s)",
		async (batched) => {
			const { screen, queryClient } = await renderEditPage();
			const title = screen.getByRole("textbox", { name: "Title", exact: true });
			if (batched) {
				server.delayRead();
				const read = queryClient.refetchQueries({ queryKey: ["content", "posts", "post_1"] });
				await vi.waitFor(() => expect(server.readPending).toBe(true));
				server.advance();
				(
					globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
				).IS_REACT_ACT_ENVIRONMENT = true;
				await React.act(async () => {
					const input = title.element() as HTMLInputElement;
					Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
						input,
						"Writer copy",
					);
					input.dispatchEvent(new Event("input", { bubbles: true }));
					server.resolveRead();
					await read;
					await vi.advanceTimersByTimeAsync(0);
				});
				(
					globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
				).IS_REACT_ACT_ENVIRONMENT = false;
			} else {
				await title.fill("Writer copy");
				server.advance();
				await queryClient.refetchQueries({ queryKey: ["content", "posts", "post_1"] });
				await vi.advanceTimersByTimeAsync(0);
			}
			await expect.element(title).toHaveValue("Writer copy");
			await vi.advanceTimersByTimeAsync(2500);
			await expect
				.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
				.toBeVisible();
			expect(server.requests.find((r) => r.method === "PUT")?.body).toMatchObject({
				data: { title: "Writer copy" },
				_rev: revision(1),
			});
			await expect.element(title).toHaveValue("Writer copy");
			await screen.getByRole("button", { name: "Save anyway", exact: true }).click();
			await vi.advanceTimersByTimeAsync(0);
			expect(server.requests.findLast((r) => r.method === "PUT")?.body).toMatchObject({
				data: { title: "Writer copy" },
				_rev: revision(2),
			});
			await expect
				.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
				.not.toBeInTheDocument();
			await vi.advanceTimersByTimeAsync(2500);
			expect(server.requests.filter((r) => r.method === "PUT")).toHaveLength(2);
			await expect.element(title).toHaveValue("Writer copy");
		},
	);
});
