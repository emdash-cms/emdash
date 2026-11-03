import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook } from "vitest-browser-react";
import { page } from "vitest/browser";

import type { AdminLayout, LayoutNavGroup } from "../../../src/lib/admin-layout";
import {
	IDLE_SAVE_QUEUE,
	pendingLayout,
	stepSaveQueue,
	useAdminLayout,
	useAdminLayoutEditor,
	type AdminLayoutEditor,
} from "../../../src/lib/api/admin-layout";
import { currentUserQueryKey, type CurrentUser } from "../../../src/lib/api/current-user";

const layoutNamed = (hidden: string): AdminLayout => ({
	version: 1,
	nav: { order: [], hidden: [hidden] },
	editor: { order: [], hidden: [] },
});

describe("stepSaveQueue", () => {
	const first = layoutNamed("/first");
	const second = layoutNamed("/second");
	const third = layoutNamed("/third");
	const failure = new Error("Database is read-only");

	it("sends a change at once when idle", () => {
		const step = stepSaveQueue(IDLE_SAVE_QUEUE, { type: "change", layout: first });
		expect(step).toEqual({
			queue: { inFlight: first, queued: null },
			send: first,
			accepted: null,
		});
		expect(pendingLayout(step.queue)).toBe(first);
	});

	it("queues a change while a save is in flight", () => {
		const step = stepSaveQueue(
			{ inFlight: first, queued: null },
			{ type: "change", layout: second },
		);
		expect(step).toEqual({
			queue: { inFlight: first, queued: second },
			send: null,
			accepted: null,
		});
		expect(pendingLayout(step.queue)).toBe(second);
	});

	it("replaces an older queued layout with the latest change", () => {
		const step = stepSaveQueue(
			{ inFlight: first, queued: second },
			{ type: "change", layout: third },
		);
		expect(step.queue).toEqual({ inFlight: first, queued: third });
		expect(step.send).toBeNull();
	});

	it("accepts the saved layout and sends the queued one", () => {
		const step = stepSaveQueue({ inFlight: first, queued: second }, { type: "saved" });
		expect(step).toEqual({
			queue: { inFlight: second, queued: null },
			send: second,
			accepted: first,
		});
	});

	it("accepts the saved layout and goes idle when nothing is queued", () => {
		const step = stepSaveQueue({ inFlight: first, queued: null }, { type: "saved" });
		expect(step).toEqual({ queue: IDLE_SAVE_QUEUE, send: null, accepted: first });
		expect(pendingLayout(step.queue)).toBeNull();
	});

	it("drops the queued layout on failure", () => {
		const step = stepSaveQueue(
			{ inFlight: first, queued: second },
			{ type: "failed", error: failure },
		);
		expect(step).toEqual({ queue: IDLE_SAVE_QUEUE, send: null, accepted: null });
		expect(pendingLayout(step.queue)).toBeNull();
	});
});

const NAV: LayoutNavGroup<{ id: string }>[] = [
	{
		key: "top",
		label: null,
		entries: [
			{ kind: "item", item: { id: "/" } },
			{ kind: "item", item: { id: "/calendar" } },
		],
	},
	{
		key: "manage",
		label: "Manage",
		entries: [
			{ kind: "item", item: { id: "/comments" } },
			{ kind: "item", item: { id: "/menus" } },
			{ kind: "item", item: { id: "/widgets" } },
		],
	},
];
const EDITOR = [{ id: "publish" }, { id: "url-language" }, { id: "seo" }];
const INPUT = { navGroups: NAV, editorSections: EDITOR };

const USER: CurrentUser = { id: "u1", email: "editor@example.com", role: 40 };

interface PostedBody {
	action: string;
	adminLayout: unknown;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * `/auth/me` with a stored layout. POSTs wait for the test to accept or fail
 * them; GETs answer at once unless held, and a held GET answers with the row
 * as it was when the request arrived.
 */
function fakeAuthMe(stored: unknown) {
	const posts: {
		body: PostedBody;
		accept: () => void;
		fail: (status: number, message: string) => void;
	}[] = [];
	const heldGets: { release: () => void; fail: () => void }[] = [];
	const server = { stored, posts, heldGets, holdGets: false, getCount: 0 };

	vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url !== "/_emdash/api/auth/me") throw new Error(`Unexpected request to ${url}`);
		const response = deferred<Response>();
		if (init?.method === "POST") {
			if (typeof init.body !== "string") throw new Error("Expected a JSON string body");
			const body = JSON.parse(init.body) as PostedBody;
			posts.push({
				body,
				accept: () => {
					server.stored = body.adminLayout;
					response.resolve(json(200, { data: { adminLayout: body.adminLayout } }));
				},
				fail: (status, message) =>
					response.resolve(json(status, { error: { code: "ADMIN_LAYOUT_SAVE_ERROR", message } })),
			});
			return response.promise;
		}
		server.getCount++;
		const user = { data: { ...USER, adminLayout: server.stored } };
		if (!server.holdGets) return Promise.resolve(json(200, user));
		heldGets.push({
			release: () => response.resolve(json(200, user)),
			fail: () => response.resolve(json(500, { error: { code: "INTERNAL", message: "Down" } })),
		});
		return response.promise;
	});
	return server;
}

let queryClient: QueryClient;

function Providers({ children }: { children: React.ReactNode }) {
	return (
		<QueryClientProvider client={queryClient}>
			<I18nProvider i18n={i18n}>
				<Toasty>{children}</Toasty>
			</I18nProvider>
		</QueryClientProvider>
	);
}

/** Render the editor as Settings does, after the shell already loaded the user. */
async function renderEditor(stored: unknown = null) {
	queryClient.setQueryData(currentUserQueryKey, { ...USER, adminLayout: stored });
	return renderHook(() => ({ layout: useAdminLayout(), editor: useAdminLayoutEditor(INPUT) }), {
		wrapper: Providers,
	});
}

async function renderReadyEditor(stored: unknown = null) {
	const hook = await renderEditor(stored);
	await vi.waitFor(() => expect(hook.result.current.editor.ready).toBe(true));
	return hook;
}

/** Let any request the queue would start next reach the fake server. */
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("useAdminLayoutEditor", () => {
	beforeEach(() => {
		queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends one save at a time and only the latest layout while one is in flight", async () => {
		const server = fakeAuthMe(null);
		const { result, act } = await renderReadyEditor();

		await act(() => result.current.editor.setVisible("nav", "/widgets", false));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		await act(() => {
			result.current.editor.setVisible("nav", "/menus", false);
			result.current.editor.setVisible("nav", "/comments", false);
		});
		await act(() => result.current.editor.move("editor", "seo", "publish"));
		await settle();
		expect(server.posts).toHaveLength(1);
		expect(server.posts[0]?.body).toEqual({
			action: "setAdminLayout",
			adminLayout: {
				version: 1,
				nav: { order: [], hidden: ["/widgets"] },
				editor: { order: [], hidden: [] },
			},
		});

		server.posts[0]?.accept();
		await vi.waitFor(() => expect(server.posts).toHaveLength(2));
		expect(server.posts[1]?.body.adminLayout).toEqual({
			version: 1,
			nav: { order: [], hidden: ["/widgets", "/menus", "/comments"] },
			editor: { order: ["seo", "publish", "url-language"], hidden: [] },
		});

		server.posts[1]?.accept();
		await settle();
		expect(server.posts).toHaveLength(2);
	});

	it("shows an edit everywhere before the server answers", async () => {
		const server = fakeAuthMe(null);
		const { result, act } = await renderReadyEditor();

		await act(() => result.current.editor.setVisible("nav", "/widgets", false));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));

		expect(result.current.layout.nav.hidden).toEqual(["/widgets"]);
		expect(result.current.editor.nav[1]?.entries[2]).toMatchObject({
			id: "/widgets",
			hidden: true,
		});
		expect(result.current.editor.customized).toEqual({ nav: true, editor: false });
	});

	it("drops the queued layout on failure, restores the accepted one, and toasts the server's message", async () => {
		const accepted = layoutNamed("/menus");
		const server = fakeAuthMe(accepted);
		const { result, act } = await renderReadyEditor(accepted);

		await act(() => result.current.editor.setVisible("nav", "/widgets", false));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		await act(() => result.current.editor.setVisible("nav", "/comments", false));
		expect(result.current.layout.nav.hidden).toEqual(["/menus", "/widgets", "/comments"]);

		server.posts[0]?.fail(500, "Database is read-only");
		await vi.waitFor(() => expect(result.current.layout).toEqual(accepted));
		await expect.element(page.getByText("Couldn't save your sidebars")).toBeVisible();
		await expect.element(page.getByText("Database is read-only")).toBeVisible();
		await settle();
		expect(server.posts).toHaveLength(1);
	});

	it("stays not ready, ignoring edits, until its reload of the user succeeds", async () => {
		const server = fakeAuthMe(null);
		server.holdGets = true;
		const { result, act } = await renderEditor();

		await vi.waitFor(() => expect(server.heldGets).toHaveLength(1));
		expect(result.current.editor.ready).toBe(false);
		await act(() => result.current.editor.setVisible("nav", "/widgets", false));
		await settle();
		expect(server.posts).toHaveLength(0);
		expect(result.current.layout.nav.hidden).toEqual([]);

		server.heldGets[0]?.release();
		await vi.waitFor(() => expect(result.current.editor.ready).toBe(true));
	});

	it("stays not ready when its reload of the user fails", async () => {
		const server = fakeAuthMe(null);
		server.holdGets = true;
		const { result } = await renderEditor();

		await vi.waitFor(() => expect(server.heldGets).toHaveLength(1));
		server.heldGets[0]?.fail();
		await vi.waitFor(() =>
			expect(queryClient.getQueryState(currentUserQueryKey)?.status).toBe("error"),
		);
		await settle();
		expect(result.current.editor.ready).toBe(false);
	});

	it("stays ready when a later refetch of the user fails", async () => {
		const server = fakeAuthMe(null);
		const { result, act } = await renderReadyEditor();

		server.holdGets = true;
		void queryClient.refetchQueries({ queryKey: currentUserQueryKey });
		await vi.waitFor(() => expect(server.heldGets).toHaveLength(1));
		server.heldGets[0]?.fail();
		await vi.waitFor(() =>
			expect(queryClient.getQueryState(currentUserQueryKey)?.status).toBe("error"),
		);
		await settle();

		expect(result.current.editor.ready).toBe(true);
		await act(() => result.current.editor.setVisible("nav", "/widgets", false));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
	});

	it("is ready at once when a save from an earlier visit is still running", async () => {
		const server = fakeAuthMe(null);
		const first = await renderReadyEditor();
		await first.act(() => first.result.current.editor.setVisible("nav", "/widgets", false));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		await first.unmount();

		server.holdGets = true;
		const second = await renderHook(() => useAdminLayoutEditor(INPUT), { wrapper: Providers });
		expect(second.result.current.ready).toBe(true);
	});

	it("does not save edits that change nothing", async () => {
		const server = fakeAuthMe(null);
		const { result, act } = await renderReadyEditor();

		await act(() => {
			result.current.editor.setVisible("nav", "/", false);
			result.current.editor.setVisible("editor", "publish", false);
			result.current.editor.setVisible("nav", "/widgets", true);
			result.current.editor.move("nav", "/widgets", "/widgets");
			result.current.editor.move("nav", "/widgets", "/calendar");
			result.current.editor.reset("nav");
		});
		await settle();
		expect(server.posts).toHaveLength(0);

		await act(() => result.current.editor.setVisible("nav", "/widgets", false));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
	});

	it("still sends a save queued before the page unmounts", async () => {
		const server = fakeAuthMe(null);
		const { result, act, unmount } = await renderReadyEditor();

		await act(() => result.current.editor.setVisible("nav", "/widgets", false));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		await act(() => result.current.editor.setVisible("nav", "/menus", false));
		await unmount();

		server.posts[0]?.accept();
		await vi.waitFor(() => expect(server.posts).toHaveLength(2));
		expect(server.posts[1]?.body.adminLayout).toMatchObject({
			nav: { order: [], hidden: ["/widgets", "/menus"] },
		});
	});

	it("still toasts a failure that arrives after the page unmounted", async () => {
		const server = fakeAuthMe(null);
		queryClient.setQueryData(currentUserQueryKey, { ...USER, adminLayout: null });
		let editor: AdminLayoutEditor<{ id: string }, { id: string }> | undefined;
		function SidebarsPage() {
			editor = useAdminLayoutEditor(INPUT);
			return null;
		}
		function App({ onSidebarsPage }: { onSidebarsPage: boolean }) {
			return onSidebarsPage ? <SidebarsPage /> : null;
		}
		const screen = await render(<App onSidebarsPage />, { wrapper: Providers });
		await vi.waitFor(() => expect(editor?.ready).toBe(true));

		editor?.setVisible("nav", "/widgets", false);
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		await screen.rerender(<App onSidebarsPage={false} />);

		server.posts[0]?.fail(500, "Database is read-only");
		await expect.element(page.getByText("Couldn't save your sidebars")).toBeVisible();
	});

	it("undoes a reset by restoring the previous list exactly, unmatched IDs included", async () => {
		const stored: AdminLayout = {
			version: 1,
			nav: { order: ["/menus", "/plugins/gone"], hidden: ["/plugins/gone", "/widgets"] },
			editor: { order: [], hidden: [] },
		};
		const server = fakeAuthMe(stored);
		const { result, act } = await renderReadyEditor(stored);
		expect(result.current.editor.customized.nav).toBe(true);

		let undo = () => {};
		await act(() => {
			undo = result.current.editor.reset("nav");
		});
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		expect(server.posts[0]?.body.adminLayout).toBeNull();
		expect(result.current.layout.nav).toEqual({ order: [], hidden: [] });
		expect(result.current.editor.customized.nav).toBe(false);

		server.posts[0]?.accept();
		await act(() => undo());
		await vi.waitFor(() => expect(server.posts).toHaveLength(2));
		expect(server.posts[1]?.body.adminLayout).toEqual(stored);
		expect(result.current.layout).toEqual(stored);
	});

	it("keeps showing an unsaved edit when the user is refetched mid-save", async () => {
		const server = fakeAuthMe(null);
		const { result, act } = await renderReadyEditor();

		await act(() => result.current.editor.setVisible("nav", "/widgets", false));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		const getsBefore = server.getCount;
		await act(() => queryClient.refetchQueries({ queryKey: currentUserQueryKey }));
		expect(server.getCount).toBeGreaterThan(getsBefore);

		expect(result.current.layout.nav.hidden).toEqual(["/widgets"]);
	});

	it("does not let a refetch that read the old row land after the save", async () => {
		const server = fakeAuthMe(null);
		const { result, act } = await renderReadyEditor();

		await act(() => result.current.editor.setVisible("nav", "/widgets", false));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		server.holdGets = true;
		void queryClient.refetchQueries({ queryKey: currentUserQueryKey });
		await vi.waitFor(() => expect(server.heldGets).toHaveLength(1));

		server.posts[0]?.accept();
		await vi.waitFor(() =>
			expect(queryClient.getQueryData<CurrentUser>(currentUserQueryKey)?.adminLayout).toEqual(
				expect.objectContaining({ nav: { order: [], hidden: ["/widgets"] } }),
			),
		);
		server.heldGets[0]?.release();
		await settle();

		expect(result.current.layout.nav.hidden).toEqual(["/widgets"]);
	});

	it("never renders the old layout again once an edit has shown, through the save landing", async () => {
		const server = fakeAuthMe(null);
		const rendered: string[][] = [];
		const { result, act } = await renderHook(
			() => {
				const layout = useAdminLayout();
				rendered.push([...layout.nav.hidden]);
				return useAdminLayoutEditor(INPUT);
			},
			{ wrapper: Providers },
		);
		await vi.waitFor(() => expect(result.current.ready).toBe(true));

		await act(() => result.current.setVisible("nav", "/widgets", false));
		await vi.waitFor(() => expect(server.posts).toHaveLength(1));
		server.posts[0]?.accept();
		await settle();

		const firstShown = rendered.findIndex((hidden) => hidden.includes("/widgets"));
		expect(firstShown).toBeGreaterThan(-1);
		expect(rendered.slice(firstShown)).toEqual(rendered.slice(firstShown).map(() => ["/widgets"]));
	});
});
