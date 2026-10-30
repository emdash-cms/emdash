import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider, RouterProvider } from "@tanstack/react-router";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

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

const BODY_MANIFEST: AdminManifest = {
	...MANIFEST,
	collections: {
		posts: {
			...MANIFEST.collections.posts!,
			fields: {
				...MANIFEST.collections.posts!.fields,
				content: { kind: "portableText", label: "Content" },
			},
		},
	},
};

const SUMMARY_MANIFEST: AdminManifest = {
	...BODY_MANIFEST,
	collections: {
		posts: {
			...BODY_MANIFEST.collections.posts!,
			fields: {
				...BODY_MANIFEST.collections.posts!.fields,
				summary: { kind: "portableText", label: "Summary" },
			},
		},
	},
};

const BLOCKS_MANIFEST: AdminManifest = {
	...MANIFEST,
	collections: {
		posts: {
			...MANIFEST.collections.posts!,
			fields: {
				...MANIFEST.collections.posts!.fields,
				layout: {
					kind: "blocks",
					label: "Layout",
					validation: { allowedTypes: ["callout"] },
					blockTypes: [
						{
							id: "callout-id",
							slug: "callout",
							label: "Callout",
							currentVersion: 1,
							source: "user",
							createdAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
							versions: [
								{
									id: "callout-v1",
									blockTypeId: "callout-id",
									version: 1,
									fields: [{ slug: "text", label: "Text", type: "portableText" }],
									fingerprint: "callout-v1",
									active: true,
									createdAt: "2026-01-01T00:00:00Z",
									updatedAt: "2026-01-01T00:00:00Z",
								},
							],
						},
					],
				},
			},
		},
	},
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

function createServer({
	manifest = MANIFEST,
	initialData = { title: "Draft title" },
	publishedData = { title: "Published title" },
}: {
	manifest?: AdminManifest;
	initialData?: Record<string, unknown>;
	publishedData?: Record<string, unknown>;
} = {}) {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let version = 1;
	let current = makeItem({
		status: "draft",
		liveRevisionId: null,
		draftRevisionId: null,
		data: initialData,
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
		if (url === "/_emdash/api/manifest") return jsonResponse({ data: manifest });
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
					data: publishedData,
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

function blockText(blocks: unknown) {
	return (blocks as Array<{ children: Array<{ text: string }> }>)
		.map((block) => block.children.map((child) => child.text).join(""))
		.join("\n");
}

function calloutBlocks(text: string) {
	return [{ _type: "callout", _version: 1, _key: "callout-1", text: textBlocks(text) }];
}

function bodyEditor() {
	return document.querySelector<HTMLElement & { editor: Editor }>("#field-content .ProseMirror");
}

function summaryEditor() {
	return document.querySelector<HTMLElement & { editor: Editor }>("#field-summary .ProseMirror");
}

function calloutEditor() {
	return (
		document
			.getElementById("field-layout.callout-1.text")
			?.querySelector<HTMLElement & { editor: Editor }>(".ProseMirror") ?? null
	);
}

async function typeAtEnd(text: string, editor = bodyEditor()!) {
	editor.focus();
	editor.editor.commands.setTextSelection(editor.editor.state.doc.content.size - 1);
	await userEvent.keyboard(text);
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
				.element(screen.getByRole("button", { name: "Save", exact: true }).query())
				.toBeNull();
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
			await screen
				.getByRole("button", { name: /Unknown author$/ })
				.nth(1)
				.click();
			await screen.getByRole("button", { name: "Restore", exact: true }).click();
			await screen
				.getByRole("dialog", { name: "Restore this version?" })
				.getByRole("button", { name: "Restore", exact: true })
				.element()
				.click();
		}
		await expect
			.element(title)
			.toHaveValue(action === "discard" ? "Published title" : "Restored title");
		await expect
			.element(screen.getByRole("button", { name: "Save", exact: true }).query())
			.toBeNull();
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

describe("ContentEditPage rich text body", () => {
	let server: ReturnType<typeof createServer>;
	beforeEach(() => {
		vi.useFakeTimers();
		server = createServer({
			manifest: BODY_MANIFEST,
			initialData: { title: "Draft title", content: textBlocks("Draft body") },
			publishedData: { title: "Published title", content: textBlocks("Published body") },
		});
	});
	afterEach(() => {
		server.restore();
		vi.useRealTimers();
	});

	it("saves the next body edit on top of a body a background read brought in", async () => {
		const { queryClient } = await renderEditPage();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Draft body"));
		server.advance({ title: "Draft title", content: textBlocks("Body saved in another tab") });
		await queryClient.refetchQueries({ queryKey: ["content", "posts", "post_1"] });
		await vi.advanceTimersByTimeAsync(2500);
		expect(server.requests.filter((r) => r.method === "PUT")).toHaveLength(0);

		await typeAtEnd("!");
		await vi.advanceTimersByTimeAsync(2500);
		const sent = server.requests.find((r) => r.method === "PUT")?.body as
			| { _rev: string; data: { content: unknown } }
			| undefined;
		expect(sent?._rev).toBe(revision(2));
		expect(blockText(sent?.data.content)).toBe("Body saved in another tab!");
		expect(blockText(server.current.data.content)).toBe("Body saved in another tab!");
	});

	it("saves the next body edit on top of a newer body a save's reload brought in", async () => {
		const { screen } = await renderEditPage();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Draft body"));
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Saved title");
		await vi.advanceTimersByTimeAsync(150);
		server.delayRead();
		await screen.getByRole("button", { name: "Save", exact: true }).click();
		await vi.waitFor(() => expect(server.readPending).toBe(true));
		server.advance({ title: "Saved title", content: textBlocks("Body saved in another tab") });
		server.resolveRead();
		await vi.advanceTimersByTimeAsync(2500);
		expect(server.requests.filter((r) => r.method === "PUT")).toHaveLength(1);

		await typeAtEnd("!");
		await vi.advanceTimersByTimeAsync(2500);
		const sent = server.requests.findLast((r) => r.method === "PUT")?.body as
			| { _rev: string; data: { content: unknown } }
			| undefined;
		expect(sent?._rev).toBe(revision(3));
		expect(blockText(sent?.data.content)).toBe("Body saved in another tab!");
	});

	it("shows a newer body from a save's reload when the title changed during the save", async () => {
		const { screen } = await renderEditPage();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Draft body"));
		const title = screen.getByRole("textbox", { name: "Title", exact: true });
		await title.fill("Saved title");
		await vi.advanceTimersByTimeAsync(150);
		server.delayRead();
		await screen.getByRole("button", { name: "Save", exact: true }).click();
		await vi.waitFor(() => expect(server.readPending).toBe(true));
		await title.fill("Saved title, edited during the save");
		server.advance({ title: "Saved title", content: textBlocks("Body saved in another tab") });
		server.resolveRead();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Body saved in another tab"));

		await typeAtEnd("!");
		await vi.advanceTimersByTimeAsync(2500);
		const sent = server.requests.findLast((r) => r.method === "PUT")?.body as
			| { data: { content: unknown } }
			| undefined;
		expect(blockText(sent?.data.content)).toBe("Body saved in another tab!");
	});

	it("saves body text typed during a save under the save's revision", async () => {
		vi.useRealTimers();
		const { screen } = await renderEditPage();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Draft body"));
		await typeAtEnd(" saved");
		server.delayRead();
		await screen.getByRole("button", { name: "Save", exact: true }).click();
		await vi.waitFor(() => expect(server.readPending).toBe(true));
		await typeAtEnd(" and more");
		server.resolveRead();

		await vi.waitFor(
			() => {
				const sent = server.requests.findLast((r) => r.method === "PUT")?.body as
					| { _rev: string; data: { content: unknown } }
					| undefined;
				expect(blockText(sent?.data.content)).toBe("Draft body saved and more");
				expect(sent?._rev).toBe(revision(2));
			},
			{ timeout: 5000 },
		);
		expect(bodyEditor()?.textContent).toBe("Draft body saved and more");
	});

	it("shows the conflict notice when body text typed during a save meets a newer save", async () => {
		vi.useRealTimers();
		const { screen } = await renderEditPage();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Draft body"));
		await typeAtEnd(" saved");
		server.delayRead();
		await screen.getByRole("button", { name: "Save", exact: true }).click();
		await vi.waitFor(() => expect(server.readPending).toBe(true));
		await typeAtEnd(" and more");
		server.advance({ title: "Draft title", content: textBlocks("Body saved in another tab") });
		server.resolveRead();

		await expect
			.element(screen.getByRole("button", { name: "Save anyway", exact: true }), { timeout: 5000 })
			.toBeVisible();
		expect(bodyEditor()?.textContent).toBe("Draft body saved and more");
		expect(server.requests.findLast((r) => r.method === "PUT")?.body).toMatchObject({
			_rev: revision(2),
		});
		expect(blockText(server.current.data.content)).toBe("Body saved in another tab");
	});

	it("keeps the body's own autosave when an older read lands after it", async () => {
		const { queryClient } = await renderEditPage();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Draft body"));
		const older = server.current;
		server.delayRead();
		void queryClient.refetchQueries({ queryKey: ["content", "posts", "post_1"] });
		await vi.waitFor(() => expect(server.readPending).toBe(true));
		await typeAtEnd(" more");
		await vi.advanceTimersByTimeAsync(2500);
		expect(server.current._rev).toBe(revision(2));
		server.resolveRead(older);
		await vi.advanceTimersByTimeAsync(0);

		await typeAtEnd("!");
		await vi.advanceTimersByTimeAsync(2500);
		const sent = server.requests.findLast((r) => r.method === "PUT")?.body as
			| { _rev: string; data: { content: unknown } }
			| undefined;
		expect(sent?._rev).toBe(revision(2));
		expect(blockText(sent?.data.content)).toBe("Draft body more!");
	});

	it("replaces unsaved body edits after a discard", async () => {
		vi.useRealTimers();
		server.publishWithDraft();
		const { screen } = await renderEditPage();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Draft body"));
		await typeAtEnd(" with unsaved words");
		await screen.getByRole("button", { name: "Discard changes", exact: true }).click();
		await screen
			.getByRole("dialog", { name: "Discard draft changes?" })
			.getByRole("button", { name: "Discard changes", exact: true })
			.element()
			.click();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Published body"));
		await expect.element(screen.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
	});
});

describe("ContentEditPage with two rich text fields", () => {
	let server: ReturnType<typeof createServer>;
	beforeEach(() => {
		server = createServer({
			manifest: SUMMARY_MANIFEST,
			initialData: {
				title: "Draft title",
				content: textBlocks("Draft body"),
				summary: textBlocks("Draft summary"),
			},
		});
	});
	afterEach(() => {
		server.restore();
	});

	it("keeps the editor the writer types in when a save's reload replaces another field", async () => {
		const { screen } = await renderEditPage();
		await vi.waitFor(() => expect(bodyEditor()?.textContent).toBe("Draft body"));
		await typeAtEnd(" saved");
		server.delayRead();
		await screen.getByRole("button", { name: "Save", exact: true }).click();
		await vi.waitFor(() => expect(server.readPending).toBe(true));
		await typeAtEnd(" and more");
		const typingIn = bodyEditor();
		server.advance({ ...server.current.data, summary: textBlocks("Summary saved in another tab") });
		server.resolveRead();

		await vi.waitFor(() =>
			expect(summaryEditor()?.textContent).toBe("Summary saved in another tab"),
		);
		expect(bodyEditor()).toBe(typingIn);
		expect(bodyEditor()?.textContent).toBe("Draft body saved and more");
	});
});

describe("ContentEditPage rich text in blocks", () => {
	let server: ReturnType<typeof createServer>;
	beforeEach(() => {
		vi.useFakeTimers();
		server = createServer({
			manifest: BLOCKS_MANIFEST,
			initialData: { title: "Draft title", layout: calloutBlocks("Draft callout") },
		});
	});
	afterEach(() => {
		server.restore();
		vi.useRealTimers();
	});

	it("saves the next block text edit on top of a block a background read brought in", async () => {
		const { queryClient } = await renderEditPage();
		await vi.waitFor(() => expect(calloutEditor()?.textContent).toBe("Draft callout"));
		server.advance({ title: "Draft title", layout: calloutBlocks("Callout saved in another tab") });
		await queryClient.refetchQueries({ queryKey: ["content", "posts", "post_1"] });
		await vi.advanceTimersByTimeAsync(2500);
		expect(server.requests.filter((r) => r.method === "PUT")).toHaveLength(0);

		await typeAtEnd("!", calloutEditor()!);
		await vi.advanceTimersByTimeAsync(2500);
		const sent = server.requests.find((r) => r.method === "PUT")?.body as
			| { _rev: string; data: { layout: Array<{ text: unknown }> } }
			| undefined;
		expect(sent?._rev).toBe(revision(2));
		expect(blockText(sent?.data.layout[0]?.text)).toBe("Callout saved in another tab!");
	});
});
