// @vitest-environment jsdom

import { runInThisContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
