// @vitest-environment jsdom

import { constants as vmConstants, runInThisContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderToolbar } from "../../../src/visual-editing/toolbar.js";
import { EDITORIAL_TOOLBAR_LABELS, GERMAN_TOOLBAR_LABELS } from "../../utils/toolbar-labels.js";

const LABELS = { ...GERMAN_TOOLBAR_LABELS, ...EDITORIAL_TOOLBAR_LABELS };

const MANIFEST = {
	success: true,
	data: {
		collections: {
			posts: {
				fields: {
					title: { kind: "string", label: "Title" },
					body: { kind: "portableText", label: "Body" },
					excerpt: { kind: "text" },
					seo: { kind: "json", label: "SEO" },
				},
			},
		},
	},
};

const THREADS_URL = /^\/_emdash\/api\/content\/posts\/([^/]+)\/threads(?:\/(.*))?$/;

function ref(id: string, field?: string): string {
	return JSON.stringify(field ? { collection: "posts", id, field } : { collection: "posts", id });
}

function annotated(id: string, field?: string, text = "Text"): string {
	const element = document.createElement("p");
	element.setAttribute("data-emdash-ref", ref(id, field));
	element.textContent = text;
	return element.outerHTML;
}

function thread(
	id: string,
	anchor: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		collection: "posts",
		entryId: "post-1",
		anchor,
		anchorState: "attached",
		status: "open",
		createdBy: "user-1",
		resolvedBy: null,
		resolvedAt: null,
		createdAt: "2026-11-01T10:00:00.000Z",
		updatedAt: "2026-11-01T10:00:00.000Z",
		comments: [
			{
				id: `${id}-c1`,
				threadId: id,
				author: { id: "user-1", name: "Grace", avatarUrl: null },
				body: "Check this",
				createdAt: "2026-11-01T10:00:00.000Z",
				editedAt: null,
				deletedAt: null,
				can: { edit: true, delete: true },
			},
		],
		mentions: [],
		can: { resolve: true, delete: true },
		...overrides,
	};
}

function mountPage(content: string): void {
	document.body.innerHTML =
		content + renderToolbar({ editMode: true, isPreview: false, labels: LABELS });
	for (const script of document.body.querySelectorAll("script")) {
		runInThisContext(script.textContent ?? "", {
			importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
		});
	}
}

type ThreadHandler = (
	id: string,
	rest: string | undefined,
	init: RequestInit | undefined,
) => Response | Promise<Response>;

const ISLAND_PAGE = "/_emdash/visual-editing/comments";

/** A module like the island's, handing `mount()` to the test through a global. */
const ISLAND_MODULE = `data:text/javascript,${encodeURIComponent(
	"export const Host = { mount: () => globalThis.__emdashCommentsTest.mount() };",
)}`;

const ISLAND_HTML = `<!doctype html><body><astro-island uid="1" component-url="${ISLAND_MODULE}" component-export="Host" renderer-url="/r.js" client="only"></astro-island></body>`;

function stubApi(
	threads: ThreadHandler,
	islandPage: () => Response = () => new Response(ISLAND_HTML),
) {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/_emdash/api/manifest") return Response.json(MANIFEST);
		if (url === ISLAND_PAGE) return islandPage();
		const path = url.split("?")[0]!;
		const match = THREADS_URL.exec(path);
		if (match) return threads(match[1]!, match[2], init);
		return Response.json({ success: true, data: {} });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function listOf(items: unknown[]): Response {
	return Response.json({ success: true, data: { items } });
}

function trigger(name: string): HTMLButtonElement {
	const button = [...document.querySelectorAll<HTMLButtonElement>(".emdash-cm-trigger")].find(
		(candidate) => candidate.getAttribute("aria-label") === name,
	);
	if (!button) throw new Error(`No comment control named "${name}"`);
	return button;
}

function waitForTrigger(name: string): Promise<HTMLButtonElement> {
	return vi.waitFor(() => trigger(name));
}

interface OpenOptions {
	anchor: HTMLElement;
	title: string;
	field: string | null;
	threads: Array<{ id: string }>;
	loadFailed: boolean;
	threadsUrl: string;
	adminUrl: string;
	onThreadChange: (thread: unknown) => void;
	onClose: () => void;
}

function stubPopover() {
	const popover = { open: vi.fn<(options: OpenOptions) => void>(), close: vi.fn() };
	const mount = vi.fn(() => popover);
	vi.stubGlobal("__emdashCommentsTest", { mount });
	return { mount, popover };
}

const documentListeners: Parameters<typeof document.addEventListener>[] = [];

beforeEach(() => {
	// jsdom has no layout, so give elements a box unless they are hidden.
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		return this.closest("[hidden]") ? new DOMRect() : new DOMRect(0, 0, 100, 20);
	});
	const addListener = document.addEventListener.bind(document);
	vi.spyOn(document, "addEventListener").mockImplementation((...args) => {
		documentListeners.push(args);
		addListener(...args);
	});
});

afterEach(() => {
	for (const args of documentListeners.splice(0)) document.removeEventListener(...args);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("editorial comments in the toolbar", () => {
	it("loads each entry's open threads once, with at most four requests in flight", async () => {
		const pending: Array<() => void> = [];
		const fetchMock = stubApi(
			() =>
				new Promise<Response>((resolve) => {
					pending.push(() => resolve(listOf([])));
				}),
		);
		const ids = ["a", "b", "c", "d", "e", "f"];
		mountPage(ids.map((id) => annotated(id) + annotated(id, "title")).join(""));

		const threadRequests = () =>
			fetchMock.mock.calls
				.map(([url]) => url)
				.filter((url) => THREADS_URL.test(url.split("?")[0]!));

		await vi.waitFor(() => expect(threadRequests()).toHaveLength(4));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(threadRequests()).toHaveLength(4);

		pending.shift()!();
		await vi.waitFor(() => expect(threadRequests()).toHaveLength(5));
		pending.shift()!();
		await vi.waitFor(() => expect(threadRequests()).toHaveLength(6));
		for (const answer of pending.splice(0)) answer();

		expect(threadRequests()).toEqual(
			ids.map((id) => `/_emdash/api/content/posts/${id}/threads?status=open&limit=100`),
		);
	});

	it("badges the entry and each field with open threads, counting text and block threads toward their field", async () => {
		stubApi(() =>
			listOf([
				thread("t-entry", { type: "entry" }),
				thread("t-title", { type: "field", field: "title" }),
				thread("t-block", { type: "block", field: "body", blockKey: "k1" }),
				thread("t-text", {
					type: "text",
					field: "body",
					blockKey: "k1",
					start: 0,
					end: 4,
					quote: "Text",
					prefix: "",
					suffix: "",
				}),
			]),
		);
		mountPage(
			annotated("post-1") +
				annotated("post-1", "title") +
				annotated("post-1", "body") +
				annotated("post-1", "excerpt"),
		);

		const entry = await waitForTrigger("Comments on this entry: 1 open");
		expect(entry.textContent).toBe("1");
		expect(trigger("Comments on Title: 1 open").textContent).toBe("1");
		expect(trigger("Comments on Body: 2 open").textContent).toBe("2");
		const excerpt = trigger("Comment on excerpt");
		expect(excerpt.textContent).toBe("");
		expect(excerpt.classList.contains("emdash-cm-trigger--has-threads")).toBe(false);
	});

	it("counts and lists threads on fields with no badge on the page in the entry's popover", async () => {
		const { popover } = stubPopover();
		stubApi(() =>
			listOf([
				thread("t-entry", { type: "entry" }),
				thread("t-title", { type: "field", field: "title" }),
				thread("t-hidden", { type: "field", field: "excerpt" }),
				thread("t-absent", { type: "field", field: "seo" }),
			]),
		);
		mountPage(
			annotated("post-1") +
				annotated("post-1", "title") +
				annotated("post-1", "excerpt").replace("<p ", "<p hidden "),
		);

		const entry = await waitForTrigger("Comments on this entry: 3 open");
		expect(trigger("Comments on Title: 1 open").textContent).toBe("1");
		entry.click();
		await vi.waitFor(() => expect(popover.open).toHaveBeenCalled());

		const options = popover.open.mock.calls[0]![0];
		expect(options.threads.map((t) => t.id)).toEqual(["t-entry", "t-hidden", "t-absent"]);
		expect(options).toMatchObject({ fieldLabels: { excerpt: "excerpt", seo: "SEO" } });
	});

	it("orders the controls by their elements on the page, whichever entry's threads arrive first", async () => {
		const answers = new Map<string, () => void>();
		stubApi(
			(id) =>
				new Promise<Response>((resolve) => {
					answers.set(id, () => resolve(listOf([])));
				}),
		);
		mountPage(
			annotated("a") + annotated("a", "title") + annotated("b", "body") + annotated("b", "excerpt"),
		);
		await vi.waitFor(() => expect(answers.size).toBe(2));

		answers.get("b")!();
		await vi.waitFor(() => expect(document.querySelectorAll(".emdash-cm-trigger")).toHaveLength(2));
		answers.get("a")!();
		await vi.waitFor(() => expect(document.querySelectorAll(".emdash-cm-trigger")).toHaveLength(4));

		expect(
			Array.from(document.querySelectorAll(".emdash-cm-trigger"), (control) =>
				control.getAttribute("aria-label"),
			),
		).toEqual([
			"Comment on this entry",
			"Comment on Title",
			"Comment on Body",
			"Comment on excerpt",
		]);
	});

	it("shows the comment control of an element already under the pointer when its threads arrive", async () => {
		let answer!: () => void;
		stubApi(
			() =>
				new Promise<Response>((resolve) => {
					answer = () => resolve(listOf([]));
				}),
		);
		mountPage(annotated("post-1", "title"));
		await vi.waitFor(() => expect(answer).toBeTypeOf("function"));

		document
			.querySelector("[data-emdash-ref]")!
			.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		answer();

		const control = await waitForTrigger("Comment on Title");
		expect(control.hasAttribute("data-active")).toBe(true);
	});

	it("imports the popover once from the comments page's island and opens it on the badge", async () => {
		const { mount, popover } = stubPopover();
		const fetchMock = stubApi(() => listOf([thread("t-1", { type: "field", field: "seo" })]));
		mountPage(annotated("post-1", "seo.title"));

		const badge = await waitForTrigger("Comments on SEO: 1 open");
		badge.click();
		badge.click();
		await vi.waitFor(() => expect(popover.open).toHaveBeenCalled());

		expect(fetchMock.mock.calls.filter(([url]) => url === ISLAND_PAGE)).toHaveLength(1);
		expect(mount).toHaveBeenCalledTimes(1);
		const options = popover.open.mock.calls[0]![0];
		expect(options).toMatchObject({
			anchor: badge,
			title: "Comments on SEO",
			field: "seo",
			loadFailed: false,
			threadsUrl: "/_emdash/api/content/posts/post-1/threads",
			adminUrl: "/_emdash/admin/content/posts/post-1",
		});
		expect(options.threads.map((t) => t.id)).toEqual(["t-1"]);
		expect(badge.getAttribute("aria-expanded")).toBe("true");

		options.onThreadChange(thread("t-2", { type: "field", field: "seo" }));
		expect(badge.getAttribute("aria-label")).toBe("Comments on SEO: 2 open");
		options.onThreadChange(thread("t-1", { type: "field", field: "seo" }, { status: "resolved" }));
		expect(badge.getAttribute("aria-label")).toBe("Comments on SEO: 1 open");

		options.onClose();
		expect(badge.getAttribute("aria-expanded")).toBe("false");
	});

	it("opens the thread in the admin, and logs why, when the popover can't load", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const open = vi.fn();
		vi.stubGlobal("open", open);
		const fetchMock = stubApi(
			() => listOf([thread("t-1", { type: "field", field: "title" })]),
			() => new Response("<!doctype html><body></body>"),
		);
		mountPage(annotated("post-1", "title"));

		const badge = await waitForTrigger("Comments on Title: 1 open");
		badge.click();
		await vi.waitFor(() =>
			expect(open).toHaveBeenCalledWith(
				"/_emdash/admin/content/posts/post-1?thread=t-1",
				"emdash-admin-posts/post-1",
			),
		);
		expect(error).toHaveBeenCalledWith(
			expect.stringMatching(/^\[emdash\] The comment popover failed to load/),
			expect.objectContaining({ message: expect.stringContaining("component-url") }),
		);

		badge.click();
		expect(open).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.filter(([url]) => url === ISLAND_PAGE)).toHaveLength(1);
	});

	it("shows no comment controls for a user who can't read threads", async () => {
		const fetchMock = stubApi(() => new Response(null, { status: 403 }));
		mountPage(annotated("post-1", "title"));

		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining("/threads?"),
				expect.anything(),
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(document.querySelector(".emdash-cm-trigger")).toBeNull();
	});
});
