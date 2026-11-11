/**
 * The entry editor page in a room, with a fake room standing in for the session and a server
 * that records every request.
 */

import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { ThemeProvider } from "../../src/components/ThemeProvider";
import type { AdminManifest, ContentItem, EntryRef } from "../../src/lib/api";
import { RoomSaveError, type CoEditing, type RoomEvent } from "../../src/lib/co-editing/types";
import { createAdminRouter } from "../../src/router";
import { render } from "../utils/render.tsx";
import { createRoom, SAVED, type FakeRoom } from "./fake-room";

/** The page's co-editing session, played by each test. */
const session = vi.hoisted(() => ({
	view: { mode: "pending", waiting: false } as unknown,
	listeners: new Set<() => void>(),
	onEvent: null as ((event: unknown) => void) | null,
}));
vi.mock("../../src/lib/co-editing/hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/co-editing/hooks")>();
	const { useSyncExternalStore } = await import("react");
	return {
		...actual,
		useCoEditing(options: { onEvent(event: unknown): void }) {
			session.onEvent = options.onEvent;
			return useSyncExternalStore(
				(listener) => {
					session.listeners.add(listener);
					return () => session.listeners.delete(listener);
				},
				() => session.view,
			);
		},
	};
});

function show(view: CoEditing) {
	session.view = view;
	for (const listener of session.listeners) listener();
}

function roomView(fake: FakeRoom): CoEditing {
	return {
		mode: "room",
		room: fake.room,
		access: "edit",
		editable: true,
		offline: false,
		unreachable: false,
		kept: null,
		reload: vi.fn(),
		manifest: MANIFEST,
	};
}

function emit(event: RoomEvent) {
	session.onEvent?.(event);
}

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "room-page",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
			hasSeo: true,
			fields: {
				title: { kind: "string", label: "Title" },
				authors: {
					kind: "reference",
					label: "Authors",
					validation: {
						relation: "posts_authors",
						relationSide: "parent",
						targetCollection: "authors",
						multiple: true,
					},
				},
			},
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

const AUTHORS: EntryRef[] = [
	{
		id: "author_ada",
		slug: "ada",
		collection: "authors",
		title: "Ada Lovelace",
		locale: "en",
		translationGroup: "author_ada",
	},
	{
		id: "author_grace",
		slug: "grace",
		collection: "authors",
		title: "Grace Hopper",
		locale: "en",
		translationGroup: "author_grace",
	},
];

/** A published entry with a draft of its own: "Publish changes". */
function entry(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "post_1",
		type: "posts",
		slug: "post-one",
		status: "published",
		locale: "en",
		translationGroup: "post_1",
		data: { title: "First post" },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		publishedAt: "2026-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: "revision-live",
		draftRevisionId: "revision-draft",
		seo: {
			title: "Stored title",
			description: "Stored description",
			image: null,
			canonical: null,
			noIndex: false,
		},
		...overrides,
	};
}

interface RecordedRequest {
	method: string;
	url: string;
	body: Record<string, unknown> | undefined;
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** The entry on the server, which each write returns as it stands. */
function createServer(initial: ContentItem) {
	const originalFetch = globalThis.fetch;
	const server = {
		item: initial,
		manifest: MANIFEST,
		lock: { enabled: false, holder: null, heldByCaller: false, room: false } as Record<
			string,
			unknown
		>,
		refuseRecovery: false,
		/** Answers a recovery revision in place of the server, when set. */
		recoveryReply: null as Promise<Response> | null,
		refuseWrites: false,
		/** The reference field's entries, as a read returns them. */
		authors: AUTHORS,
		/** Answers a reference save in place of the server, when it returns a response. */
		answerReferenceWrite: null as (() => Response | Promise<Response> | undefined) | null,
		requests: [] as RecordedRequest[],
		/** Requests other than reads, and the room's saves, in the order they happened. */
		log: [] as string[],
		reads: (path: string) =>
			server.requests.filter(
				(request) => request.method === "GET" && request.url.split("?")[0] === path,
			).length,
		find: (method: string, path: string) =>
			server.requests.find((request) => request.method === method && request.url.startsWith(path)),
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
	const write = () => json({ data: { item: server.item, _rev: "rev-server" } });

	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		server.requests.push({ method, url, body });
		const path = url.split("?")[0]!;
		if (method !== "GET") server.log.push(`${method} ${path}`);

		if (method === "GET" && path === "/_emdash/api/manifest")
			return json({ data: server.manifest });
		if (method === "GET" && path === "/_emdash/api/auth/me") {
			return json({ data: { id: "user_1", role: 40 } });
		}
		if (
			method === "GET" &&
			(path.startsWith("/_emdash/api/bylines") || path === "/_emdash/api/users")
		) {
			return json({ data: { items: [] } });
		}
		if (method === "GET" && path.endsWith("/revisions")) {
			return json({ data: { items: [], total: 0 } });
		}
		if (method === "GET" && path.startsWith("/_emdash/api/revisions/")) {
			return json({
				data: {
					item: {
						id: path.split("/").at(-1),
						collection: "posts",
						entryId: "post_1",
						data: server.item.data,
						authorId: null,
						createdAt: "2026-01-02T00:00:00Z",
					},
				},
			});
		}
		if (method === "GET" && path === "/_emdash/api/content/posts/post_1") {
			return json({
				data: {
					item: { ...server.item, references: { authors: { children: server.authors } } },
					_rev: "rev-server",
				},
			});
		}
		if (path === "/_emdash/api/content/posts/post_1/lock") return json({ data: server.lock });
		if (method === "POST" && path === "/_emdash/api/content/posts/post_1/revisions") {
			if (server.recoveryReply) return server.recoveryReply;
			if (server.refuseRecovery) {
				return json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Too large to keep" } }, 413);
			}
			return json({ data: { id: "revision-recovery" } }, 201);
		}
		if (path.startsWith("/_emdash/api/content/posts/post_1")) {
			if (method === "PUT" && server.refuseWrites) {
				return json({ error: { code: "FORBIDDEN", message: "Not allowed" } }, 403);
			}
			if (method === "PUT" && body?.references) {
				const answer = server.answerReferenceWrite?.();
				if (answer) return answer;
			}
			if (method === "PUT" && body?.seo) {
				server.item = { ...server.item, seo: { ...server.item.seo!, ...body.seo } };
			}
			if (method === "POST" && path.endsWith("/schedule")) {
				server.item = { ...server.item, scheduledAt: String(body?.scheduledAt) };
			}
			if (method === "DELETE" && path.endsWith("/schedule")) {
				server.item = { ...server.item, scheduledAt: null };
			}
			return write();
		}
		return json({ error: { code: "NOT_FOUND", message: `No ${method} ${url}` } }, 404);
	}) as typeof fetch;

	return server;
}

let openServer: ReturnType<typeof createServer> | undefined;
let unmount: (() => Promise<void>) | undefined;

afterEach(async () => {
	await unmount?.();
	unmount = undefined;
	openServer?.restore();
	openServer = undefined;
	session.view = { mode: "pending", waiting: false };
	session.onEvent = null;
});

/** Opens the entry in a room whose saves the server log records. */
async function openInRoom(
	item: ContentItem,
	setup: { view?: CoEditing; prepare?: (server: ReturnType<typeof createServer>) => void } = {},
) {
	const server = createServer(item);
	openServer = server;
	setup.prepare?.(server);
	const log = server.log;
	const fake = createRoom({ title: "First post", slug: "post-one" });
	fake.whenCovered.mockImplementation(async (options) => {
		log.push(`whenCovered save=${options.save}`);
	});
	show(setup.view ?? roomView(fake));
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	const screen = await render(
		<I18nProvider i18n={i18n}>
			<ThemeProvider defaultTheme="light">
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</ThemeProvider>
		</I18nProvider>,
	);
	unmount = () => screen.unmount();
	await expect
		.element(screen.getByRole("textbox", { name: "Title", exact: true }))
		.toHaveValue("First post");
	return { screen, fake, server, queryClient, router };
}

/** Clicks a dialog's action once it shows, past the layer its opening animation puts over it. */
async function confirm(
	screen: Awaited<ReturnType<typeof render>>,
	dialog: string,
	action: string,
): Promise<void> {
	const button = screen
		.getByRole("dialog", { name: dialog })
		.getByRole("button", { name: action, exact: true });
	await expect.element(button).toBeVisible();
	(button.element() as HTMLButtonElement).click();
}

function localDateKey(date: Date): string {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

describe("operations in a room", () => {
	it("publishes the room's kept save, with no PUT and no _rev", async () => {
		const { screen, server } = await openInRoom(entry());

		await screen.getByRole("button", { name: "Publish changes", exact: true }).click();
		await confirm(screen, "Publish changes?", "Publish changes");

		await vi.waitFor(() =>
			expect(server.log).toEqual([
				"whenCovered save=true",
				"POST /_emdash/api/content/posts/post_1/publish",
			]),
		);
		expect(server.find("POST", "/_emdash/api/content/posts/post_1/publish")?.body?._rev).toBe(
			undefined,
		);
	});

	it("unpublishes the room's kept save, with no PUT and no _rev", async () => {
		const { screen, server } = await openInRoom(entry({ draftRevisionId: null }));

		await screen.getByRole("button", { name: "Unpublish Post" }).click();

		await vi.waitFor(() =>
			expect(server.log).toEqual([
				"whenCovered save=true",
				"POST /_emdash/api/content/posts/post_1/unpublish",
			]),
		);
		expect(server.find("POST", "/_emdash/api/content/posts/post_1/unpublish")?.body?._rev).toBe(
			undefined,
		);
	});

	it("schedules and unschedules the room's kept save, with no PUT", async () => {
		const { screen, server } = await openInRoom(entry());

		await screen.getByRole("button", { name: "Schedule" }).click();
		const dialog = screen.getByRole("dialog", { name: "Schedule changes" });
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		const day = dialog
			.element()
			.querySelector<HTMLButtonElement>(`[data-day="${localDateKey(tomorrow)}"] button`);
		fireEvent.click(day!);
		await dialog.getByRole("textbox", { name: "Hour" }).fill("09");
		await dialog.getByRole("textbox", { name: "Minute" }).fill("00");
		await confirm(screen, "Schedule changes", "Schedule changes");
		await vi.waitFor(() =>
			expect(server.log).toEqual([
				"whenCovered save=true",
				"POST /_emdash/api/content/posts/post_1/schedule",
			]),
		);

		await screen.getByRole("button", { name: "Remove schedule" }).click();
		await vi.waitFor(() =>
			expect(server.log.slice(2)).toEqual([
				"whenCovered save=true",
				"DELETE /_emdash/api/content/posts/post_1/schedule",
			]),
		);
	});

	it("discards the draft and moves the entry to Trash after the room's kept save", async () => {
		const { screen, server } = await openInRoom(entry());

		await screen.getByRole("button", { name: "Discard changes" }).click();
		await confirm(screen, "Discard draft changes?", "Discard changes");
		await vi.waitFor(() =>
			expect(server.log).toEqual([
				"whenCovered save=true",
				"POST /_emdash/api/content/posts/post_1/discard-draft",
			]),
		);

		await screen.getByRole("button", { name: "Move to Trash" }).click();
		await confirm(screen, "Move to Trash?", "Move to Trash");
		await vi.waitFor(() =>
			expect(server.log.slice(2)).toEqual([
				"whenCovered save=true",
				"DELETE /_emdash/api/content/posts/post_1",
			]),
		);
	});

	it("publishes a reference edit still on its way once its save lands", async () => {
		const { screen, server } = await openInRoom(entry());
		let land = () => {};
		server.answerReferenceWrite = () => {
			server.answerReferenceWrite = null;
			return new Promise((resolve) => {
				land = () => {
					server.log.push("PUT landed");
					resolve(json({ data: { item: server.item, _rev: "rev-server" } }));
				};
			});
		};

		await screen.getByRole("button", { name: "Remove Grace Hopper" }).click();
		await vi.waitFor(() => expect(server.log).toEqual(["PUT /_emdash/api/content/posts/post_1"]));
		await screen.getByRole("button", { name: "Publish changes", exact: true }).click();
		await confirm(screen, "Publish changes?", "Publish changes");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(server.log).toEqual(["PUT /_emdash/api/content/posts/post_1"]);

		land();
		await vi.waitFor(() =>
			expect(server.log).toEqual([
				"PUT /_emdash/api/content/posts/post_1",
				"PUT landed",
				"whenCovered save=true",
				"POST /_emdash/api/content/posts/post_1/publish",
			]),
		);
	});

	it("doesn't publish a reference edit whose save fails, and says why", async () => {
		const { screen, server } = await openInRoom(entry(), {
			prepare: (fake) => (fake.refuseWrites = true),
		});

		await screen.getByRole("button", { name: "Remove Grace Hopper" }).click();
		await expect.element(screen.getByText("Not allowed")).toBeVisible();
		await screen.getByRole("button", { name: "Publish changes", exact: true }).click();
		await confirm(screen, "Publish changes?", "Publish changes");

		await expect
			.element(screen.getByText("Your edits couldn’t be saved, so this didn’t run. Try again."))
			.toBeVisible();
		expect(server.log).toEqual([
			"PUT /_emdash/api/content/posts/post_1",
			"PUT /_emdash/api/content/posts/post_1",
		]);
	});

	it("doesn't publish when the room refuses the save, and says why", async () => {
		const { screen, fake, server } = await openInRoom(entry());
		fake.whenCovered.mockRejectedValue(
			new RoomSaveError("refused", "VALIDATION_ERROR", "Title is too long"),
		);

		await screen.getByRole("button", { name: "Publish changes", exact: true }).click();
		await confirm(screen, "Publish changes?", "Publish changes");

		await expect.element(page.getByText("Title is too long")).toBeVisible();
		expect(server.log).toEqual([]);
	});
});

describe("the editor in a room", () => {
	it("keeps the fields of the manifest the room was joined with", async () => {
		const { screen, server, queryClient } = await openInRoom(entry());
		const posts = MANIFEST.collections.posts!;
		server.manifest = {
			...MANIFEST,
			hash: "room-page-2",
			collections: {
				posts: {
					...posts,
					fields: { ...posts.fields, subtitle: { kind: "string", label: "Subtitle" } },
				},
			},
		};

		await queryClient.refetchQueries({ queryKey: ["manifest"] });
		expect(queryClient.getQueryData<AdminManifest>(["manifest"])?.hash).toBe("room-page-2");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(screen.getByRole("textbox", { name: "Subtitle" }).query()).toBeNull();
		await expect
			.element(screen.getByRole("textbox", { name: "Title", exact: true }))
			.toHaveValue("First post");
	});
});

describe("reloading from a room", () => {
	/** Whether closing or reloading the tab now would ask first. */
	function asksBeforeUnload(): boolean {
		const event = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(event);
		return event.defaultPrevented;
	}

	it("reloads without asking once a recovery revision holds the edits, and says so", async () => {
		const { screen, fake } = await openInRoom(entry());
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Typed");
		await vi.waitFor(() => expect(asksBeforeUnload()).toBe(true));

		fake.setSaveState(SAVED);
		show({ mode: "reloading" });

		expect(asksBeforeUnload()).toBe(false);
		await expect.element(screen.getByText("Reloading the admin")).toBeVisible();
	});

	it("shows edits it can no longer save on the save button, through a reload", async () => {
		const { screen, fake } = await openInRoom(entry());
		const kept = { ...roomView(fake), kept: "deleted" as const };

		show(kept);

		const popover = screen.getByRole("dialog", { name: "Your last edits weren’t saved" });
		await expect.element(popover).toHaveTextContent(/moved to Trash or deleted/);
		await expect.element(screen.getByRole("button", { name: "Not saved" })).toBeVisible();
		await popover.getByRole("button", { name: "Reload" }).click();
		expect(kept.reload).toHaveBeenCalledOnce();

		show({ mode: "reloading" });

		await expect.element(screen.getByRole("button", { name: "Not saved" })).toBeVisible();
		expect(screen.getByText("Reloading the admin").query()).toBeNull();
	});
});

describe("resetting a room", () => {
	it("keeps the fields blank until the new replica syncs, instead of showing the entry as loaded", async () => {
		const { screen, fake } = await openInRoom(entry());
		const title = screen.getByRole("textbox", { name: "Title", exact: true });
		fake.remote({ title: "Edited in the room" });
		await expect.element(title).toHaveValue("Edited in the room");

		show({ mode: "pending", waiting: true });

		await expect.element(title).not.toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "SEO Title" }).query()).not.toBeNull();
		await expect.element(screen.getByRole("button", { name: "Joining…" })).toBeEnabled();
		await new Promise((resolve) => setTimeout(resolve, 2000));
		expect(title.query()).toBeNull();

		show(roomView(createRoom({ title: "From the new replica", slug: "post-one" })));

		await expect.element(title).toHaveValue("From the new replica");
		await expect.element(title).toBeEnabled();
	});

	it("shows the entry as it's now saved once a reset ends in single-editor mode", async () => {
		const { screen, fake, server } = await openInRoom(entry());
		const title = screen.getByRole("textbox", { name: "Title", exact: true });
		fake.remote({ title: "Edited in the room" });
		await expect.element(title).toHaveValue("Edited in the room");
		server.item = { ...server.item, data: { title: "Saved by the room" } };

		show({ mode: "pending", waiting: false });
		show({ mode: "single-editor", canJoin: true, deleted: false, takeOver: vi.fn() });

		await expect.element(title).toHaveValue("Saved by the room");
	});

	it("keeps the editor mounted, so its view survives", async () => {
		const { screen } = await openInRoom(entry());
		await screen.getByRole("button", { name: "Enter distraction-free mode" }).click();
		const exit = screen.getByRole("button", { name: "Exit distraction-free mode" });
		await expect.element(exit).toBeVisible();

		show({ mode: "pending", waiting: false });

		await expect
			.element(screen.getByRole("textbox", { name: "Title", exact: true }))
			.not.toBeInTheDocument();
		await expect.element(exit).toBeVisible();
		show(roomView(createRoom({ title: "From the new replica", slug: "post-one" })));
		await expect
			.element(screen.getByRole("textbox", { name: "Title", exact: true }))
			.toHaveValue("From the new replica");
		await expect.element(exit).toBeVisible();
	});

	it("saves a pending SEO edit as the room does, without _rev", async () => {
		const { screen, server } = await openInRoom(entry());
		await screen.getByRole("textbox", { name: "SEO Title" }).fill("A better title");

		show({ mode: "pending", waiting: false });

		await vi.waitFor(() => expect(server.log).toEqual(["PUT /_emdash/api/content/posts/post_1"]));
		expect(server.find("PUT", "/_emdash/api/content/posts/post_1")?.body).toEqual({
			seo: { title: "A better title" },
		});
	});
});

describe("values outside the document in a room", () => {
	it("saves SEO at once without _rev, sending only what changed", async () => {
		const { screen, server } = await openInRoom(entry());

		await screen.getByRole("textbox", { name: "SEO Title" }).fill("A better title");

		await vi.waitFor(() => expect(server.log).toEqual(["PUT /_emdash/api/content/posts/post_1"]));
		expect(server.find("PUT", "/_emdash/api/content/posts/post_1")?.body).toEqual({
			seo: { title: "A better title" },
		});
	});

	it("keeps another person's SEO change while this tab edits another SEO value", async () => {
		const { screen, server } = await openInRoom(entry());
		const description = screen.getByRole("textbox", { name: "Meta Description" });
		const seoTitle = screen.getByRole("textbox", { name: "SEO Title" });
		const puts = () =>
			server.requests.filter(
				(request) => request.method === "PUT" && request.url.startsWith("/_emdash/api/content"),
			);

		await description.fill("Ben's description");
		await vi.waitFor(() => expect(puts()).toHaveLength(1));
		await vi.waitFor(() => expect(server.reads("/_emdash/api/content/posts/post_1")).toBe(2));

		await description.fill("Ben's longer description");
		server.item = { ...server.item, seo: { ...server.item.seo!, title: "Ana's title" } };
		emit({ kind: "values", values: ["seo"] });
		(
			screen.getByRole("textbox", { name: "Title", exact: true }).element() as HTMLInputElement
		).focus();

		await expect.element(seoTitle).toHaveValue("Ana's title");
		await expect.element(description).toHaveValue("Ben's longer description");
		await vi.waitFor(() => expect(puts()).toHaveLength(2));
		expect(puts()[1]?.body).toEqual({ seo: { description: "Ben's longer description" } });
		expect(server.item.seo?.title).toBe("Ana's title");
	});

	it("sends a refused SEO value again with the next SEO change", async () => {
		const { screen, server } = await openInRoom(entry(), {
			prepare: (fake) => (fake.refuseWrites = true),
		});
		const puts = () =>
			server.requests.filter(
				(request) => request.method === "PUT" && request.url.startsWith("/_emdash/api/content"),
			);

		await screen.getByRole("textbox", { name: "SEO Title" }).fill("A better title");
		await expect.element(screen.getByText("Not allowed")).toBeVisible();
		server.refuseWrites = false;
		await screen.getByRole("textbox", { name: "Meta Description" }).fill("A description");

		await vi.waitFor(() => expect(puts()).toHaveLength(2));
		expect(puts()[1]?.body).toEqual({
			seo: { title: "A better title", description: "A description" },
		});
	});

	it("keeps a reference selection in its input when the server refuses it", async () => {
		const { screen, server } = await openInRoom(entry(), {
			prepare: (fake) => (fake.refuseWrites = true),
		});

		await screen.getByRole("button", { name: "Remove Grace Hopper" }).click();

		await vi.waitFor(() => expect(server.log).toEqual(["PUT /_emdash/api/content/posts/post_1"]));
		await expect.element(screen.getByText("Not allowed")).toBeVisible();
		expect(screen.getByRole("button", { name: "Remove Grace Hopper" }).query()).toBeNull();
		await expect.element(screen.getByRole("button", { name: "Remove Ada Lovelace" })).toBeVisible();
	});

	it("asks before leaving while a list save failed, and sends it again on the way out", async () => {
		const { screen, server, router } = await openInRoom(entry(), {
			prepare: (fake) => (fake.refuseWrites = true),
		});
		const puts = () =>
			server.requests.filter(
				(request) => request.method === "PUT" && request.url.startsWith("/_emdash/api/content"),
			);
		const asksBeforeUnload = () => {
			const event = new Event("beforeunload", { cancelable: true });
			window.dispatchEvent(event);
			return event.defaultPrevented;
		};

		await screen.getByRole("button", { name: "Remove Grace Hopper" }).click();
		await expect.element(screen.getByText("Not allowed")).toBeVisible();
		expect(asksBeforeUnload()).toBe(true);

		void router.navigate({ to: "/" });
		await confirm(screen, "Leave without saving?", "Stay");
		expect(puts()).toHaveLength(2);
		expect(router.state.location.pathname).toBe("/content/posts/post_1");

		server.refuseWrites = false;
		await router.navigate({ to: "/" });
		await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
		expect(puts()).toHaveLength(3);
		expect(puts()[2]?.body).toMatchObject({ references: { authors: ["author_ada"] } });
	});

	it("saves a reference edit at once without _rev or a revision", async () => {
		const { screen, server } = await openInRoom(entry());

		await screen.getByRole("button", { name: "Remove Grace Hopper" }).click();

		await vi.waitFor(() => expect(server.log).toEqual(["PUT /_emdash/api/content/posts/post_1"]));
		expect(server.find("PUT", "/_emdash/api/content/posts/post_1")?.body).toEqual({
			references: { authors: ["author_ada"] },
			expected: { references: { authors: ["author_ada", "author_grace"] } },
			skipRevision: true,
		});
	});

	it("saves a reference edit to more entries than a save can name without the list it was based on", async () => {
		const others: EntryRef[] = Array.from({ length: 999 }, (_, index) => ({
			id: `author_${index}`,
			slug: `author-${index}`,
			collection: "authors",
			title: `Author ${index}`,
			locale: "en",
			translationGroup: `author_${index}`,
		}));
		const { screen, server } = await openInRoom(entry(), {
			prepare: (created) => {
				created.authors = [...AUTHORS, ...others];
			},
		});

		await screen.getByRole("button", { name: "Remove Grace Hopper" }).click();

		await vi.waitFor(() => expect(server.log).toEqual(["PUT /_emdash/api/content/posts/post_1"]));
		expect(server.find("PUT", "/_emdash/api/content/posts/post_1")?.body).toEqual({
			references: { authors: ["author_ada", ...others.map((other) => other.id)] },
			skipRevision: true,
		});
	});

	it("saves a reference edit again on top of another person's, when theirs landed first", async () => {
		const { screen, server } = await openInRoom(entry());
		const alan: EntryRef = {
			id: "author_alan",
			slug: "alan",
			collection: "authors",
			title: "Alan Turing",
			locale: "en",
			translationGroup: "author_alan",
		};
		server.answerReferenceWrite = () => {
			server.answerReferenceWrite = null;
			server.authors = [...AUTHORS, alan];
			return json({ error: { code: "LIST_CONFLICT", message: "The list changed" } }, 409);
		};

		await screen.getByRole("button", { name: "Remove Grace Hopper" }).click();

		const puts = () =>
			server.requests.filter(
				(request) => request.method === "PUT" && request.url.startsWith("/_emdash/api/content"),
			);
		await vi.waitFor(() => expect(puts()).toHaveLength(2));
		expect(puts()[1]?.body).toEqual({
			references: { authors: ["author_ada", "author_alan"] },
			expected: { references: { authors: ["author_ada", "author_grace", "author_alan"] } },
			skipRevision: true,
		});
		await expect.element(screen.getByRole("button", { name: "Remove Alan Turing" })).toBeVisible();
		expect(screen.getByText("The list changed").query()).toBeNull();
	});

	it("reloads a value saved elsewhere once its input loses focus", async () => {
		const { screen, server } = await openInRoom(entry());
		const reads = () => server.reads("/_emdash/api/content/posts/post_1");
		const seoTitle = screen.getByRole("textbox", { name: "SEO Title" });
		(seoTitle.element() as HTMLInputElement).focus();
		const before = reads();

		emit({ kind: "values", values: ["seo"] });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(reads()).toBe(before);

		(
			screen.getByRole("textbox", { name: "Title", exact: true }).element() as HTMLInputElement
		).focus();
		await vi.waitFor(() => expect(reads()).toBe(before + 1));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(reads()).toBe(before + 1);
	});
});

describe("joining a room from single-editor mode", () => {
	const REVISIONS = "/_emdash/api/content/posts/post_1/revisions";
	const ACTIONS = [
		["a Take over", "editor", "Take over"],
		["a Join", "room", "Join"],
	] as const;

	/** Unsaved edits in a tab that then lost the lock to another editor, or to a room. */
	async function openWithUnsavedEdits(lockedBy: "editor" | "room") {
		const takeOver = vi.fn();
		const opened = await openInRoom(entry(), {
			view: { mode: "single-editor", canJoin: true, deleted: false, takeOver },
			prepare(server) {
				server.lock = { enabled: true, holder: null, heldByCaller: true, room: false };
			},
		});
		const { screen, server } = opened;
		const title = screen.getByRole("textbox", { name: "Title", exact: true });
		await title.fill("Unsaved title");
		server.lock = {
			enabled: true,
			holder: { userId: "user_2", userName: "Ana Lima", acquiredAt: "", expiresAt: "" },
			heldByCaller: false,
			room: lockedBy === "room",
		};
		document.dispatchEvent(new Event("visibilitychange"));
		const action = lockedBy === "room" ? "Join" : "Take over";
		await expect.element(screen.getByRole("button", { name: action, exact: true })).toBeVisible();
		return { ...opened, takeOver, title };
	}

	/** The session's answer to the click. */
	function answer(view: CoEditing) {
		show({ mode: "pending", waiting: false });
		show(view);
	}

	it.each(ACTIONS)(
		"keeps unsaved edits in a recovery revision once %s opens a room",
		async (_, lockedBy, action) => {
			const { screen, server, takeOver } = await openWithUnsavedEdits(lockedBy);

			await screen.getByRole("button", { name: action, exact: true }).click();

			expect(takeOver).toHaveBeenCalledTimes(1);
			expect(server.find("POST", REVISIONS)).toBeUndefined();
			answer(roomView(createRoom({ title: "First post", slug: "post-one" })));
			await vi.waitFor(() =>
				expect(server.find("POST", REVISIONS)?.body).toEqual({
					data: { title: "Unsaved title" },
					slug: "post-one",
				}),
			);
			await expect
				.element(screen.getByText("Your unsaved edits are in a recovery revision"))
				.toBeVisible();
		},
	);

	it.each(ACTIONS)(
		"saves no recovery revision when %s leaves the tab in single-editor mode",
		async (_, lockedBy, action) => {
			const { screen, server, takeOver, title } = await openWithUnsavedEdits(lockedBy);

			await screen.getByRole("button", { name: action, exact: true }).click();

			expect(takeOver).toHaveBeenCalledTimes(1);
			answer({ mode: "single-editor", canJoin: true, deleted: false, takeOver });
			await expect.element(title).toHaveValue("Unsaved title");
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(server.find("POST", REVISIONS)).toBeUndefined();
		},
	);

	it("saves a reference edit it hadn't sent once Join opens a room", async () => {
		const takeOver = vi.fn();
		const { screen, server } = await openInRoom(entry(), {
			view: { mode: "single-editor", canJoin: true, deleted: false, takeOver },
			prepare(fake) {
				fake.lock = { enabled: true, holder: null, heldByCaller: true, room: false };
			},
		});
		await screen.getByRole("button", { name: "Remove Grace Hopper" }).click();
		server.lock = {
			enabled: true,
			holder: { userId: "user_2", userName: "Ana Lima", acquiredAt: "", expiresAt: "" },
			heldByCaller: false,
			room: true,
		};
		document.dispatchEvent(new Event("visibilitychange"));
		const join = screen.getByRole("button", { name: "Join", exact: true });
		await expect.element(join).toBeVisible();
		expect(server.find("PUT", "/_emdash/api/content/posts/post_1")).toBeUndefined();

		await join.click();
		answer(roomView(createRoom({ title: "First post", slug: "post-one" })));

		await vi.waitFor(() =>
			expect(server.find("PUT", "/_emdash/api/content/posts/post_1")?.body).toEqual({
				references: { authors: ["author_ada"] },
				expected: { references: { authors: ["author_ada", "author_grace"] } },
				skipRevision: true,
			}),
		);
	});

	it("keeps unsaved edits in a recovery revision when Join finds the admin out of date", async () => {
		const { screen, server, title } = await openWithUnsavedEdits("room");

		await screen.getByRole("button", { name: "Join", exact: true }).click();
		emit({ kind: "outdated" });
		answer({ mode: "single-editor", canJoin: true, deleted: false, takeOver: vi.fn() });

		await vi.waitFor(() =>
			expect(server.find("POST", REVISIONS)?.body).toEqual({
				data: { title: "Unsaved title" },
				slug: "post-one",
			}),
		);
		await expect
			.element(screen.getByText(/Your unsaved edits are in a recovery revision\. Reload the page/))
			.toBeVisible();
		await expect.element(title).toHaveValue("Unsaved title");
	});

	it("asks before leaving while the recovery revision for edits from before joining is on its way", async () => {
		const { screen, server } = await openWithUnsavedEdits("room");
		let reply: (response: Response) => void = () => undefined;
		server.recoveryReply = new Promise((resolve) => {
			reply = resolve;
		});
		const asksBeforeUnload = () => {
			const event = new Event("beforeunload", { cancelable: true });
			window.dispatchEvent(event);
			return event.defaultPrevented;
		};

		await screen.getByRole("button", { name: "Join", exact: true }).click();
		answer(roomView(createRoom({ title: "First post", slug: "post-one" })));
		await vi.waitFor(() => expect(server.find("POST", REVISIONS)).toBeDefined());

		expect(asksBeforeUnload()).toBe(true);
		expect(screen.getByRole("dialog").query()).toBeNull();

		reply(new Response(JSON.stringify({ data: { id: "revision-recovery" } }), { status: 201 }));
		await expect
			.element(screen.getByText("Your unsaved edits are in a recovery revision"))
			.toBeVisible();
		expect(asksBeforeUnload()).toBe(false);
	});

	it("holds on to edits whose recovery revision failed, to copy or keep again", async () => {
		const { screen, server } = await openWithUnsavedEdits("room");
		server.refuseRecovery = true;
		const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
		const asksBeforeUnload = () => {
			const event = new Event("beforeunload", { cancelable: true });
			window.dispatchEvent(event);
			return event.defaultPrevented;
		};
		const recoveries = () =>
			server.requests.filter((request) => request.method === "POST" && request.url === REVISIONS);
		try {
			await screen.getByRole("button", { name: "Join", exact: true }).click();
			answer(roomView(createRoom({ title: "First post", slug: "post-one" })));

			const popover = screen.getByRole("dialog", { name: "Your earlier edits weren’t kept" });
			await expect.element(popover).toHaveTextContent("Too large to keep");
			expect(asksBeforeUnload()).toBe(true);

			await popover.getByRole("button", { name: "Copy my edits" }).click();
			expect(writeText).toHaveBeenCalledWith("Title\nUnsaved title");

			server.refuseRecovery = false;
			await popover.getByRole("button", { name: "Try again" }).click();

			await expect
				.element(screen.getByText("Your unsaved edits are in a recovery revision"))
				.toBeVisible();
			expect(recoveries().map((request) => request.body)).toEqual([
				{ data: { title: "Unsaved title" }, slug: "post-one" },
				{ data: { title: "Unsaved title" }, slug: "post-one" },
			]);
			await expect.element(popover).not.toBeInTheDocument();
			expect(asksBeforeUnload()).toBe(false);
		} finally {
			writeText.mockRestore();
		}
	});
});

describe("a room that's out of reach", () => {
	it("says EmDash can't be reached, not that the browser is offline, while it's online", async () => {
		const { screen, fake } = await openInRoom(entry());

		show({ ...roomView(fake), offline: true, unreachable: true });
		await screen.getByRole("button", { name: "Offline" }).click();

		await expect.element(screen.getByRole("dialog", { name: "Can’t reach EmDash" })).toBeVisible();
		expect(screen.getByText("You’re offline").query()).toBeNull();
	});
});

describe("room notices", () => {
	it("reads the entry again once a publish cycle starts a new draft, not at every save", async () => {
		const { screen, server } = await openInRoom(entry());
		const reads = () => server.reads("/_emdash/api/content/posts/post_1");
		const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
		const save = () => emit({ kind: "checkpoint", rev: "rev-room", editedBy: ["user_2"] });
		const start = reads();

		save();
		await settle();
		expect(reads()).toBe(start);

		// Someone publishes: the entry has no draft of its own until the next save.
		server.item = entry({ draftRevisionId: "revision-live" });
		emit({ kind: "operation", by: "user_2" });
		await expect.element(screen.getByRole("button", { name: "Unpublish Post" })).toBeVisible();
		expect(reads()).toBe(start + 1);
		server.item = entry({ draftRevisionId: "revision-draft-2" });
		save();
		await expect
			.element(screen.getByRole("button", { name: "Publish changes", exact: true }))
			.toBeVisible();
		expect(reads()).toBe(start + 2);
		save();
		save();
		await settle();
		expect(reads()).toBe(start + 2);
	});

	it("reads the entry again when the tab reconnects, since saves meanwhile sent it no checkpoint", async () => {
		const { screen, server } = await openInRoom(entry({ draftRevisionId: "revision-live" }));
		await expect.element(screen.getByRole("button", { name: "Unpublish Post" })).toBeVisible();

		server.item = entry({ draftRevisionId: "revision-draft-2" });
		emit({ kind: "reconnected" });

		await expect
			.element(screen.getByRole("button", { name: "Publish changes", exact: true }))
			.toBeVisible();
	});

	it("names who ran an operation, except to the person who ran it", async () => {
		const { fake } = await openInRoom(entry());
		fake.present("user_ana", "Ana Lima");

		emit({ kind: "operation", by: "user_1" });
		emit({ kind: "operation", by: "user_ana" });
		emit({ kind: "operation", by: "user_gone" });

		await expect.element(page.getByText("Ana Lima changed this entry")).toBeVisible();
		await expect.element(page.getByText("Someone changed this entry")).toBeVisible();
		expect(page.getByText("changed this entry").elements()).toHaveLength(2);
	});

	it("shows an entry moved to Trash read-only", async () => {
		const { screen, server } = await openInRoom(entry());

		show({ mode: "single-editor", canJoin: true, deleted: true, takeOver: vi.fn() });

		await expect
			.element(screen.getByText("This entry was moved to Trash or deleted"))
			.toBeVisible();
		await expect
			.element(screen.getByRole("textbox", { name: "Title", exact: true }))
			.toBeDisabled();
		expect(server.find("POST", "/_emdash/api/content/posts/post_1/lock")).toBeUndefined();
	});
});
