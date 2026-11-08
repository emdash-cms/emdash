// @vitest-environment jsdom

import { runInThisContext } from "node:vm";

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePortableTextEditor } from "../../../src/components/InlinePortableTextEditor.js";
import { renderToolbar } from "../../../src/visual-editing/toolbar.js";
import { GERMAN_TOOLBAR_LABELS } from "../../utils/toolbar-labels.js";

const LABELS = {
	publish: "Publish",
	publishing: "Publishing…",
	sessionExpired: "Session expired",
	refreshPage: "Refresh page",
	publishFailed: "Publish failed",
	editMode: "Edit",
	openInAdmin: "Open in admin",
	hideToolbar: "Hide toolbar",
	draft: "Draft",
	published: "Published",
	unpublishedChanges: "Unpublished changes",
	unsaved: "Unsaved",
	saving: "Saving…",
	saved: "Saved",
	saveFailed: "Save failed",
	image: "Image",
	noImageSelected: "No image selected",
	altText: "Alt text",
	altTextPlaceholder: "Describe the image",
	replaceImage: "Replace",
	uploadImage: "Upload",
	removeImage: "Remove",
	mediaLibrary: "Media Library",
	back: "Back",
	loading: "Loading…",
	noImagesFound: "No images found",
	mediaLoadFailed: "Failed to load media",
	uploadingFile: "Uploading {filename}…",
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

function mountEditablePage(
	content: string,
	options: { hidden?: boolean; labels?: typeof LABELS } = {},
): void {
	const toolbar = renderToolbar({ editMode: true, isPreview: false, labels: LABELS, ...options });
	document.body.innerHTML = content + toolbar;
	for (const script of document.body.querySelectorAll("script")) {
		runInThisContext(script.textContent ?? "");
	}
}

/** Serves the manifest, the stored post and saves. Pass `manifest` or `save` to control their answers. */
function stubApi(
	stored: Record<string, unknown> = {},
	manifest: Promise<Response> = Promise.resolve(Response.json(MANIFEST)),
	save: () => Promise<Response> = async () => Response.json({ success: true, data: {} }),
) {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/_emdash/api/manifest") return manifest;
		if (init?.method === "PUT") return save();
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

describe("toolbar language", () => {
	function toolbarText() {
		return {
			saveStatus: document.getElementById("emdash-tb-save-status")!.textContent,
			entryStatus: document.getElementById("emdash-tb-status")!.textContent,
			publish: document.getElementById("emdash-tb-publish")!.textContent,
		};
	}

	/** Stubs the API with a content save that stays in flight until it is answered. */
	function holdSave(): (status: number) => void {
		let answer!: (status: number) => void;
		stubApi(
			{},
			undefined,
			() =>
				new Promise<Response>((resolve) => {
					answer = (status) => resolve(new Response(null, { status }));
				}),
		);
		return (status) => answer(status);
	}

	async function startEditingTitle(): Promise<HTMLElement> {
		mountEditablePage(`<h1 data-emdash-ref='${ref("title")}'>Hello</h1>`, {
			labels: GERMAN_TOOLBAR_LABELS,
		});
		const title = document.querySelector("h1")!;
		title.click();
		await waitForEditing(title);
		return title;
	}

	it("keeps Publish in the editor's language after a save leaves unpublished changes", async () => {
		const answerSave = holdSave();
		const title = await startEditingTitle();

		title.textContent = "Hallo";
		title.dispatchEvent(new FocusEvent("blur"));
		answerSave(200);

		await vi.waitFor(() =>
			expect(toolbarText()).toEqual({
				saveStatus: "Gespeichert",
				entryStatus: "Unveröffentlichte Änderungen",
				publish: "Veröffentlichen",
			}),
		);

		// An unanswered publish keeps jsdom from reloading the page.
		vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
		document.getElementById("emdash-tb-publish")!.click();

		await vi.waitFor(() => expect(toolbarText().publish).toBe("Wird veröffentlicht…"));
	});

	it.each([
		["succeeds", 200, "Gespeichert"],
		["fails", 500, "Speichern fehlgeschlagen"],
	])("shows a save that %s in the editor's language", async (_outcome, status, outcomeBadge) => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const answerSave = holdSave();
		const title = await startEditingTitle();

		title.textContent = "Hallo";
		title.dispatchEvent(new Event("input"));
		expect(toolbarText().saveStatus).toBe("Nicht gespeichert");

		title.dispatchEvent(new FocusEvent("blur"));
		expect(toolbarText().saveStatus).toBe("Wird gespeichert…");

		answerSave(status);
		await vi.waitFor(() => expect(toolbarText().saveStatus).toBe(outcomeBadge));
	});

	it.each([
		["a draft", { status: "draft" }, "Entwurf"],
		[
			"a published entry with changes",
			{ status: "published", hasDraft: true },
			"Unveröffentlichte Änderungen",
		],
		["a published entry", { status: "published" }, "Veröffentlicht"],
	])("labels %s in the editor's language", (_entry, state, badge) => {
		stubApi();
		const entry = JSON.stringify({ collection: "posts", id: "post-1", ...state });
		mountEditablePage(`<article data-emdash-ref='${entry}'></article>`, {
			labels: GERMAN_TOOLBAR_LABELS,
		});

		expect(toolbarText().entryStatus).toBe(badge);
	});
});

describe("toolbar admin link", () => {
	it("opens each entry in its own admin window", () => {
		stubApi();
		const entry = JSON.stringify({ collection: "posts", id: "post-1", status: "published" });
		mountEditablePage(`<article data-emdash-ref='${entry}'></article>`);

		const adminLink = document.getElementById("emdash-tb-admin") as HTMLAnchorElement;
		expect(adminLink.getAttribute("href")).toBe("/_emdash/admin/content/posts/post-1");
		expect(adminLink.target).toBe("emdash-admin-posts/post-1");
	});
});

describe("toolbar multi-entry publishing", () => {
	function entry(id: string, state: Record<string, unknown> = {}, collection = "posts") {
		return `<h2 data-emdash-ref='${JSON.stringify({ collection, id, field: "title", status: "published", ...state })}'>${id}</h2>`;
	}

	function publishButton() {
		return document.getElementById("emdash-tb-publish") as HTMLButtonElement;
	}

	function holdPublishing() {
		const published: string[] = [];
		let answer!: (response: Response) => void;
		let reject!: (error: Error) => void;
		const reload = vi.fn();
		vi.stubGlobal("location", { reload });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/publish")) {
					published.push(url);
					return new Promise<Response>((resolve, rejectRequest) => {
						answer = resolve;
						reject = rejectRequest;
					});
				}
				return Response.json(MANIFEST);
			}),
		);
		return {
			published,
			reload,
			answer: (response: Response) => answer(response),
			reject: (error: Error) => reject(error),
		};
	}

	it("finds drafts after a published entry and ignores malformed and duplicate annotations", async () => {
		const api = holdPublishing();
		mountEditablePage(
			`<div data-emdash-ref='invalid'></div>` +
				entry("live") +
				entry("pending", { hasDraft: true }) +
				entry("pending", { hasDraft: true }) +
				entry("new", { status: "draft" }),
		);
		expect(document.getElementById("emdash-tb-status")!.textContent).toBe("Draft");
		expect(publishButton().style.display).not.toBe("none");
		publishButton().click();
		await vi.waitFor(() => expect(api.published).toHaveLength(1));
		api.answer(new Response(null, { status: 200 }));
		await vi.waitFor(() => expect(api.published).toHaveLength(2));
		expect(api.published).toEqual([
			"/_emdash/api/visual-editing/content/posts/pending/publish",
			"/_emdash/api/visual-editing/content/posts/new/publish",
		]);
	});

	it("shows unpublished changes when only a later entry has a draft", () => {
		holdPublishing();
		mountEditablePage(entry("live") + entry("pending", { hasDraft: true }));
		expect(document.getElementById("emdash-tb-status")!.textContent).toBe("Unpublished changes");
		expect(publishButton().style.display).not.toBe("none");
	});

	it.each([403, 409, "network"])(
		"publishes later entries even when the first fails with %s",
		async (failure) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			const api = holdPublishing();
			mountEditablePage(entry("blocked", { hasDraft: true }) + entry("mine", { hasDraft: true }));
			publishButton().click();
			if (failure === "network") {
				api.reject(new Error("Disconnected"));
			} else {
				api.answer(
					Response.json({ error: { message: "Cannot publish this entry" } }, { status: failure }),
				);
			}
			await vi.waitFor(() => expect(api.published).toHaveLength(2));
			expect(publishButton().disabled).toBe(true);
			api.answer(new Response(null, { status: 200 }));
			await vi.waitFor(() => expect(publishButton().disabled).toBe(false));
			expect(document.getElementById("emdash-tb-status")!.textContent).toBe(
				failure === "network" ? "Publish failed" : "Cannot publish this entry",
			);
			expect(api.reload).not.toHaveBeenCalled();
			publishButton().click();
			await vi.waitFor(() => expect(api.published).toHaveLength(3));
			expect(api.published.map((url) => url.split("/").at(-2))).toEqual([
				"blocked",
				"mine",
				"blocked",
			]);
		},
	);

	it("publishes both saved entries, including a save that finishes while Publish waits", async () => {
		const api = holdPublishing();
		mountEditablePage(entry("one") + entry("two"));
		await editInPlace(document.querySelectorAll("h2")[0]!, "Edited one");
		await vi.waitFor(() => expect(publishButton().style.display).not.toBe("none"));
		let finishSave!: () => void;
		const done = new Promise<void>((resolve) => {
			finishSave = resolve;
		});
		document.dispatchEvent(new CustomEvent("emdash:save-pending", { detail: { done } }));
		publishButton().click();
		expect(api.published).toEqual([]);
		document.dispatchEvent(
			new CustomEvent("emdash:content-changed", { detail: { collection: "posts", id: "two" } }),
		);
		finishSave();
		await vi.waitFor(() => expect(api.published).toHaveLength(1));
		api.answer(new Response(null, { status: 200 }));
		await vi.waitFor(() => expect(api.published).toHaveLength(2));
		expect(api.published.map((url) => url.split("/").at(-2))).toEqual(["one", "two"]);
	});

	it("publishes both inline-edited entries before reloading", async () => {
		const api = holdPublishing();
		mountEditablePage(entry("one") + entry("two"));
		await editInPlace(document.querySelectorAll("h2")[0]!, "Edited one");
		await editInPlace(document.querySelectorAll("h2")[1]!, "Edited two");
		await vi.waitFor(() =>
			expect(document.getElementById("emdash-tb-save-status")!.textContent).toBe("Saved"),
		);
		publishButton().click();
		await vi.waitFor(() => expect(api.published).toHaveLength(1));
		api.answer(new Response(null, { status: 200 }));
		await vi.waitFor(() => expect(api.published).toHaveLength(2));
		expect(api.reload).not.toHaveBeenCalled();
		api.answer(new Response(null, { status: 200 }));
		await vi.waitFor(() => expect(api.reload).toHaveBeenCalledTimes(1));
		expect(api.published.map((url) => url.split("/").at(-2))).toEqual(["one", "two"]);
	});

	it("does not lose a new save of an entry while its publish request is in flight", async () => {
		const api = holdPublishing();
		mountEditablePage(entry("one", { hasDraft: true }));
		publishButton().click();
		document.dispatchEvent(
			new CustomEvent("emdash:content-changed", { detail: { collection: "posts", id: "one" } }),
		);
		api.answer(new Response(null, { status: 200 }));
		await vi.waitFor(() => expect(api.published).toHaveLength(2));
		expect(api.reload).not.toHaveBeenCalled();
		api.answer(new Response(null, { status: 200 }));
		await vi.waitFor(() => expect(api.reload).toHaveBeenCalledTimes(1));
	});

	it.each(["http", "network"])(
		"keeps remaining entries retryable after a partial %s failure",
		async (failure) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			const api = holdPublishing();
			mountEditablePage(
				entry("same", { hasDraft: true }) + entry("same", { hasDraft: true }, "pages"),
			);
			publishButton().click();
			api.answer(new Response(null, { status: 200 }));
			await vi.waitFor(() => expect(api.published).toHaveLength(2));
			if (failure === "http") {
				api.answer(Response.json({ error: { message: "Try again" } }, { status: 500 }));
			} else {
				api.reject(new Error("Disconnected"));
			}
			await vi.waitFor(() => expect(publishButton().disabled).toBe(false));
			expect(document.getElementById("emdash-tb-status")!.textContent).toBe(
				failure === "http" ? "Try again" : "Publish failed",
			);
			expect(api.reload).not.toHaveBeenCalled();
			publishButton().click();
			await vi.waitFor(() => expect(api.published).toHaveLength(3));
			expect(api.published).toEqual([
				"/_emdash/api/visual-editing/content/posts/same/publish",
				"/_emdash/api/visual-editing/content/pages/same/publish",
				"/_emdash/api/visual-editing/content/pages/same/publish",
			]);
		},
	);
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
				// One window per entry, so this entry's admin tab is reused and no other entry's is replaced.
				"emdash-admin-posts/post-1",
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
