// @vitest-environment jsdom

import { runInThisContext } from "node:vm";

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePortableTextEditor } from "../../../src/components/InlinePortableTextEditor.js";
import { renderToolbar } from "../../../src/visual-editing/toolbar.js";

const LABELS = {
	publish: "Publish",
	publishing: "Publishing…",
	sessionExpired: "Session expired",
	refreshPage: "Refresh page",
	publishFailed: "Publish failed",
	editMode: "Edit",
	openInAdmin: "Open in admin",
	hideToolbar: "Hide toolbar",
};

const MANIFEST = {
	success: true,
	data: {
		collections: {
			posts: {
				fields: {
					title: { kind: "string" },
					excerpt: { kind: "richText" },
				},
			},
		},
	},
};

function ref(field: string): string {
	return JSON.stringify({ collection: "posts", id: "post-1", field });
}

function mountEditablePage(content: string, options: { hidden?: boolean } = {}): void {
	const toolbar = renderToolbar({ editMode: true, isPreview: false, labels: LABELS, ...options });
	document.body.innerHTML = content + toolbar;
	for (const script of document.body.querySelectorAll("script")) {
		runInThisContext(script.textContent ?? "");
	}
}

/** Serves the manifest and the stored post. Pass `manifest` to control when the manifest arrives. */
function stubApi(
	stored: Record<string, unknown> = {},
	manifest: Promise<Response> = Promise.resolve(Response.json(MANIFEST)),
) {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/_emdash/api/manifest") return manifest;
		if (init?.method === "PUT") return Response.json({ success: true, data: {} });
		return Response.json({ success: true, data: { item: { data: stored } } });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function expectSaved(fetchMock: ReturnType<typeof stubApi>, data: Record<string, unknown>) {
	return vi.waitFor(() =>
		expect(fetchMock).toHaveBeenCalledWith(
			"/_emdash/api/content/posts/post-1",
			expect.objectContaining({ method: "PUT", body: JSON.stringify({ data }) }),
		),
	);
}

function waitForEditing(element: HTMLElement) {
	return vi.waitFor(() => expect(element.hasAttribute("data-emdash-editing")).toBe(true));
}

async function editInPlace(element: HTMLElement, text: string): Promise<void> {
	element.click();
	await waitForEditing(element);
	element.textContent = text;
	element.dispatchEvent(new FocusEvent("blur"));
}

// Each mounted toolbar adds click listeners to the shared document; remove them
// so a toolbar from one test doesn't handle clicks in the next.
const documentListeners: Parameters<typeof document.addEventListener>[] = [];

beforeEach(() => {
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

describe("toolbar inline editing", () => {
	it("edits text in place while the toolbar pill is hidden", async () => {
		const fetchMock = stubApi();
		mountEditablePage(`<h1 data-emdash-ref='${ref("title")}'>Hello</h1>`, { hidden: true });

		expect(document.getElementById("emdash-toolbar")?.hidden).toBe(true);
		await editInPlace(document.querySelector("h1")!, "Hello, edited");

		await expectSaved(fetchMock, { title: "Hello, edited" });
	});

	it("edits a text field in place when the page shows its stored text", async () => {
		const fetchMock = stubApi({ excerpt: "A short excerpt" });
		mountEditablePage(`<p data-emdash-ref='${ref("excerpt")}'>A short excerpt</p>`);

		await editInPlace(document.querySelector("p")!, "A new excerpt");

		await expectSaved(fetchMock, { excerpt: "A new excerpt" });
	});

	it.each([
		["formatted", "Some **bold** text", "<p>Some <strong>bold</strong> text</p>"],
		["shortened", "A long excerpt that goes on and on", "A long excerpt…"],
	])("opens a text field in the admin when the page shows it %s", async (_, stored, rendered) => {
		stubApi({ excerpt: stored });
		const openMock = vi.fn();
		vi.stubGlobal("open", openMock);
		mountEditablePage(`<div data-emdash-ref='${ref("excerpt")}'>${rendered}</div>`);

		const excerpt = document.querySelector("div")!;
		excerpt.click();

		await vi.waitFor(() =>
			expect(openMock).toHaveBeenCalledWith(
				"/_emdash/admin/content/posts/post-1?field=excerpt",
				"emdash-admin",
			),
		);
		expect(excerpt.hasAttribute("data-emdash-editing")).toBe(false);
	});

	it.each([
		["a <br>", "Line one<br>Line two"],
		["a <div>", "Line one<div>Line two</div>"],
	])("saves a line break the browser adds as %s", async (_, edited) => {
		const fetchMock = stubApi({ excerpt: "Line one" });
		mountEditablePage(`<p data-emdash-ref='${ref("excerpt")}'>Line one</p>`);

		const excerpt = document.querySelector("p")!;
		excerpt.click();
		await waitForEditing(excerpt);
		excerpt.innerHTML = edited;
		excerpt.dispatchEvent(new FocusEvent("blur"));

		await expectSaved(fetchMock, { excerpt: "Line one\nLine two" });
	});

	it("does not follow a surrounding link when clicking inside a field being edited", async () => {
		stubApi();
		mountEditablePage(
			`<a href="/posts/post-1"><h2 data-emdash-ref='${ref("title")}'>Hello</h2></a>`,
		);

		const title = document.querySelector("h2")!;
		title.click();
		await waitForEditing(title);

		const caretClick = new MouseEvent("click", { bubbles: true, cancelable: true });
		title.dispatchEvent(caretClick);

		expect(caretClick.defaultPrevented).toBe(true);
		expect(title.hasAttribute("data-emdash-editing")).toBe(true);
	});

	it("does not follow a surrounding link when a field is clicked before the manifest loads", async () => {
		let sendManifest!: () => void;
		stubApi(
			{},
			new Promise((resolve) => {
				sendManifest = () => resolve(Response.json(MANIFEST));
			}),
		);
		mountEditablePage(
			`<a href="/posts/post-1"><h2 data-emdash-ref='${ref("title")}'>Hello</h2></a>`,
		);

		const title = document.querySelector("h2")!;
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		title.dispatchEvent(click);
		sendManifest();

		expect(click.defaultPrevented).toBe(true);
		await waitForEditing(title);
	});
});

describe("toolbar Publish while a save is in flight", () => {
	const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
	const entry = JSON.stringify({
		collection: "posts",
		id: "post-1",
		status: "published",
		hasDraft: true,
	});
	const storedBody = [
		{
			_type: "block" as const,
			_key: "stored-a",
			style: "normal" as const,
			markDefs: [],
			children: [{ _type: "span" as const, _key: "stored-a-1", text: "Stored body.", marks: [] }],
		},
	];

	let root: Root;
	let requests: string[];
	let heldSaves: Map<string, Promise<number>>;

	/** Holds the save of `field` until the returned function answers it with a status. */
	function holdSave(field: string): (status: number) => void {
		let answer!: (status: number) => void;
		heldSaves.set(
			field,
			new Promise<number>((resolve) => {
				answer = resolve;
			}),
		);
		return answer;
	}

	beforeEach(() => {
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		requests = [];
		heldSaves = new Map();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === "/_emdash/api/manifest") return Response.json(MANIFEST);
				if (url.endsWith("/publish")) {
					requests.push("publish");
					return new Promise<Response>(() => {});
				}
				if (init?.method === "PUT" && typeof init.body === "string") {
					const [field] = Object.keys(JSON.parse(init.body).data);
					requests.push(`save ${field}`);
					const heldSave = heldSaves.get(field);
					if (heldSave) {
						const status = await heldSave;
						requests.push(`${field} answered ${status}`);
						return new Response(null, { status });
					}
				}
				return Response.json({ success: true, data: {} });
			}),
		);
	});

	afterEach(async () => {
		await act(async () => root?.unmount());
		delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
	});

	async function mountEntry() {
		mountEditablePage(
			`<article data-emdash-ref='${entry}'><h1 data-emdash-ref='${ref("title")}'>Hello</h1><div id="body"></div></article>`,
		);
		root = createRoot(document.getElementById("body")!);
		await act(async () => {
			root.render(
				React.createElement(InlinePortableTextEditor, {
					value: structuredClone(storedBody),
					collection: "posts",
					entryId: "post-1",
					field: "body",
				}),
			);
		});
	}

	// Tiptap's core puts the editor instance on its view's root element.
	async function editBody(focusTarget: HTMLElement) {
		const editable = document.querySelector<HTMLElement>(".ProseMirror")!;
		const editor = (
			editable as HTMLElement & {
				editor: { commands: { insertContentAt: (pos: number, text: string) => boolean } };
			}
		).editor;
		await act(async () => {
			editor.commands.insertContentAt(1, "Edited. ");
		});
		await act(async () => {
			editable.dispatchEvent(
				new FocusEvent("focusout", { bubbles: true, relatedTarget: focusTarget }),
			);
		});
	}

	function editTitle() {
		return editInPlace(document.querySelector("h1")!, "Hello, edited");
	}

	function publishButton(): HTMLButtonElement {
		return document.getElementById("emdash-tb-publish") as HTMLButtonElement;
	}

	function nextTask() {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	it.each([
		["a save of the Portable Text body", "body", () => editBody(publishButton()), 200],
		["a save of a text field", "title", editTitle, 200],
		["a failed save of the Portable Text body", "body", () => editBody(publishButton()), 500],
	])("publishes only after %s has finished", async (_, field, edit, status) => {
		const answerSave = holdSave(field);
		await mountEntry();

		await edit();
		publishButton().click();
		await nextTask();
		expect(requests).toEqual([`save ${field}`]);

		answerSave(status);
		await vi.waitFor(() => expect(requests).toContain("publish"));
		expect(requests).toEqual([`save ${field}`, `${field} answered ${status}`, "publish"]);
	});

	it("publishes once when Publish is clicked again while it waits", async () => {
		const answerBody = holdSave("body");
		await mountEntry();

		await editBody(publishButton());
		publishButton().click();
		publishButton().click();
		answerBody(200);
		await vi.waitFor(() => expect(requests).toContain("publish"));
		await nextTask();
		expect(requests).toEqual(["save body", "body answered 200", "publish"]);
	});

	it("publishes once when another save finishes while Publish waits", async () => {
		const answerBody = holdSave("body");
		const answerTitle = holdSave("title");
		await mountEntry();

		await editBody(document.querySelector("h1")!);
		await editTitle();
		publishButton().click();
		answerTitle(200);
		await vi.waitFor(() => expect(requests).toContain("title answered 200"));
		await nextTask();
		publishButton().click();
		answerBody(200);
		await vi.waitFor(() => expect(requests).toContain("publish"));
		await nextTask();
		expect(requests).toEqual([
			"save body",
			"save title",
			"title answered 200",
			"body answered 200",
			"publish",
		]);
	});

	it("waits for a body save that a later field save finished before", async () => {
		const answerBody = holdSave("body");
		await mountEntry();

		await editBody(document.querySelector("h1")!);
		await editTitle();
		await vi.waitFor(() => expect(requests).toContain("save title"));
		await nextTask();
		publishButton().click();
		await nextTask();
		expect(requests).toEqual(["save body", "save title"]);

		answerBody(200);
		await vi.waitFor(() => expect(requests).toContain("publish"));
		expect(requests).toEqual(["save body", "save title", "body answered 200", "publish"]);
	});
});
