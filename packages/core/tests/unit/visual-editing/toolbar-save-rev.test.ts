import { runInThisContext } from "node:vm";

import type { Editor } from "@tiptap/core";
import type { Kysely } from "kysely";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { builtinEnvironments, type EnvironmentReturn } from "vitest/runtime";

import { InlinePortableTextEditor } from "../../../src/components/InlinePortableTextEditor.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { emdashLoader, ENTRY_REV } from "../../../src/loader.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { renderToolbar } from "../../../src/visual-editing/toolbar.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { GERMAN_TOOLBAR_LABELS } from "../../utils/toolbar-labels.js";

const LABELS = {
	...GERMAN_TOOLBAR_LABELS,
	saveConflict: "Content changed. Refresh before saving.",
	entryLocked: "Entry locked. Open it in the admin.",
};

function blocks(text: string) {
	return [
		{
			_type: "block" as const,
			_key: "body",
			style: "normal" as const,
			markDefs: [],
			children: [{ _type: "span" as const, _key: "span", text, marks: [] }],
		},
	];
}

describeEachDialect("visual editor revision safety", (dialect) => {
	let context: DialectTestContext;
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;
	let id: string;
	let initialRev: string;
	let publishes: number;
	let refusedCode: string | undefined;
	let environment: EnvironmentReturn;
	let root: Root;
	let mounted: boolean;
	let saveGate: Promise<void> | undefined;
	let readGate: Promise<void> | undefined;
	let readFailure: number | undefined;
	let pendingRequests: Promise<Response>[];
	let writes: Array<{ _rev: string; data: Record<string, unknown> }>;
	const documentListeners: Parameters<typeof document.addEventListener>[] = [];

	beforeEach(async () => {
		environment = await builtinEnvironments.jsdom.setup(globalThis, {
			jsdom: { url: "http://localhost" },
		});
		const addListener = document.addEventListener.bind(document);
		vi.spyOn(document, "addEventListener").mockImplementation((...args) => {
			documentListeners.push(args);
			addListener(...args);
		});
		context = await setupForDialect(dialect);
		db = context.db;
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "excerpt", label: "Excerpt", type: "text" });
		await registry.createField("posts", { slug: "body", label: "Body", type: "portableText" });
		runtime = createTestRuntime(db);
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Stored title", excerpt: "Stored excerpt", body: blocks("Stored body") },
			slug: "visual-safety",
		});
		id = created.data!.item.id;
		initialRev = created.data!._rev;
		publishes = 0;
		refusedCode = undefined;
		mounted = false;
		saveGate = undefined;
		readGate = undefined;
		readFailure = undefined;
		pendingRequests = [];
		writes = [];
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.spyOn(window, "open").mockImplementation(() => null);
		Object.defineProperty(document, "startViewTransition", {
			configurable: true,
			value: () => {},
		});
		const transport = async (url: string, init?: RequestInit) => {
			if (url === "/_emdash/api/manifest") {
				return Response.json({
					success: true,
					data: {
						collections: {
							posts: { fields: { title: { kind: "string" }, excerpt: { kind: "richText" } } },
						},
					},
				});
			}
			if (init?.method === "PUT") {
				if (typeof init.body !== "string") throw new Error("Expected serialized content data");
				const body = JSON.parse(init.body);
				writes.push(body);
				if (saveGate && !init.keepalive) await saveGate;
				if (refusedCode) {
					return Response.json(
						{ success: false, error: { code: refusedCode, message: "Untranslated server detail" } },
						{ status: 423 },
					);
				}
				const result = await runtime.handleContentUpdate("posts", id, body);
				return Response.json(result, { status: result.success ? 200 : 409 });
			}
			if (init?.method === "POST" && url.endsWith("/publish")) {
				publishes++;
				const result = await runtime.handleContentPublish(
					"posts",
					id,
					typeof init.body === "string" ? JSON.parse(init.body) : {},
				);
				return Response.json(result, { status: result.success ? 200 : 409 });
			}
			if (readGate) await readGate;
			if (readFailure)
				return Response.json(
					{
						success: false,
						error: { code: "CONTENT_GET_ERROR", message: "Untranslated server detail" },
					},
					{ status: readFailure },
				);
			return Response.json(await runtime.handleContentGet("posts", id));
		};
		vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
			const request = transport(url, init);
			pendingRequests.push(request);
			return request;
		});
	});

	afterEach(async () => {
		await Promise.allSettled(pendingRequests);
		if (mounted)
			await act(async () => {
				for (const element of document.querySelectorAll<HTMLElement>(".ProseMirror")) {
					const editor = (element as HTMLElement & { editor?: Editor }).editor;
					editor?.destroy();
				}
				root!.unmount();
			});
		for (const args of documentListeners.splice(0)) document.removeEventListener(...args);
		document.body.innerHTML = "";
		Reflect.deleteProperty(document, "startViewTransition");
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await environment.teardown(globalThis);
		await teardownForDialect(context);
	});

	function mount(field: "title" | "excerpt", includeRev = true): HTMLElement {
		const ref = JSON.stringify({
			collection: "posts",
			id,
			field,
			status: "draft",
			...(includeRev && { _rev: initialRev }),
		});
		document.body.innerHTML =
			`<p tabindex="0" data-emdash-ref='${ref}'>Stored ${field}</p>` +
			renderToolbar({ editMode: true, isPreview: false, labels: LABELS });
		for (const script of document.body.querySelectorAll("script")) {
			runInThisContext(script.textContent ?? "");
		}
		return document.querySelector("p")!;
	}

	async function startEditing(element: HTMLElement): Promise<void> {
		element.click();
		await vi.waitFor(() => expect(element.hasAttribute("data-emdash-editing")).toBe(true));
	}

	function finishEditing(element: HTMLElement, value: string): void {
		element.textContent = value;
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new FocusEvent("blur"));
	}

	async function currentDraft(): Promise<Record<string, unknown>> {
		const entry = await runtime.handleContentGet("posts", id);
		const revision = await new RevisionRepository(db).findById(entry.data!.item.draftRevisionId!);
		return revision!.data;
	}

	function saveMessage(): string | null {
		return document.querySelector("#emdash-tb-save-status")!.textContent;
	}

	it("renders a token that guards edits against the same stored row", async () => {
		const entry = await runWithContext({ db, editMode: true }, () =>
			emdashLoader().loadEntry!({ filter: { type: "posts", id: "visual-safety" } }),
		);
		if (!entry || !("data" in entry)) throw new Error("Expected a rendered entry");
		const rev = Reflect.get(entry.data, ENTRY_REV);
		expect(typeof rev).toBe("string");
		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Current title" },
			_rev: rev,
		});
		expect(saved.success).toBe(true);
		const stale = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Stale title" },
			_rev: rev,
		});
		expect(stale).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect((await currentDraft()).title).toBe("Current title");
	});

	async function mountPortableText(
		includeRev = true,
		copies = 1,
	): Promise<{ element: HTMLElement; editor: Editor }> {
		mount("excerpt", includeRev);
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		mounted = true;
		await act(async () => {
			root!.render(
				React.createElement(
					React.Fragment,
					null,
					Array.from({ length: copies }, (_value, index) =>
						React.createElement(InlinePortableTextEditor, {
							key: index,
							value: blocks("Stored body"),
							collection: "posts",
							entryId: id,
							field: "body",
							...(includeRev && { _rev: initialRev }),
						}),
					),
				),
			);
		});
		const element = container.querySelector<HTMLElement>(".ProseMirror")!;
		const editor = (element as HTMLElement & { editor: Editor }).editor;
		return { element, editor };
	}

	async function editBody(editor: Editor, element: HTMLElement, text: string): Promise<void> {
		await act(async () => {
			editor.commands.insertContentAt(1, text);
			element.dispatchEvent(
				new FocusEvent("focusout", {
					bubbles: true,
					relatedTarget: document.querySelector("#emdash-tb-publish"),
				}),
			);
		});
	}

	it("refuses stale edits and never publishes after the refused save", async () => {
		const element = mount("excerpt");
		await startEditing(element);
		const otherSave = await runtime.handleContentUpdate("posts", id, {
			data: { excerpt: "Other writer" },
			_rev: initialRev,
		});
		expect(otherSave.success).toBe(true);
		finishEditing(element, "Stale local text");
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saveConflict));
		expect((await currentDraft()).excerpt).toBe("Other writer");
		document.querySelector<HTMLButtonElement>("#emdash-tb-publish")!.click();
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saveConflict));
		expect(publishes).toBe(0);
	});

	it("does not bind a fresh token to stale rendered string data", async () => {
		const element = mount("title");
		await runtime.handleContentUpdate("posts", id, {
			data: { title: "Newer title" },
			_rev: initialRev,
		});
		element.click();
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saveConflict));
		expect(element.hasAttribute("data-emdash-editing")).toBe(false);
		expect((await currentDraft()).title).toBe("Newer title");
	});

	it("advances its own token for repeated saves and publication", async () => {
		const element = mount("excerpt");
		for (const value of ["First edit", "Second edit"]) {
			await startEditing(element);
			finishEditing(element, value);
			await vi.waitFor(async () => expect((await currentDraft()).excerpt).toBe(value));
			await vi.waitFor(() =>
				expect(document.querySelector("#emdash-tb-save-status")!.textContent).toContain(
					LABELS.saved,
				),
			);
		}
		document.querySelector<HTMLButtonElement>("#emdash-tb-publish")!.click();
		await vi.waitFor(async () => {
			const result = await runtime.handleContentGet("posts", id);
			expect(result.data!.item.status).toBe("published");
			expect(result.data!.item.data.excerpt).toBe("Second edit");
		});
		expect(publishes).toBe(1);
	});

	it("explains a refused edit lock without exposing the server message", async () => {
		const element = mount("excerpt");
		await startEditing(element);
		refusedCode = "ENTRY_LOCKED";
		finishEditing(element, "Refused edit");
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.entryLocked));
		expect(saveMessage()).not.toContain("Untranslated server detail");
	});

	it("does not attach a fresh token to stale rendered Portable Text", async () => {
		const { editor, element } = await mountPortableText();
		await runtime.handleContentUpdate("posts", id, {
			data: { body: blocks("Other writer") },
			_rev: initialRev,
		});
		await editBody(editor, element, "Local edit. ");
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saveConflict));
		expect((await currentDraft()).body).toEqual(blocks("Other writer"));
		expect(writes.every((write) => write._rev === initialRev)).toBe(true);
	});

	it("protects Portable Text from another writer after its own successful save", async () => {
		const { editor, element } = await mountPortableText();
		await editBody(editor, element, "First edit. ");
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saved));
		const current = await runtime.handleContentGet("posts", id);
		await runtime.handleContentUpdate("posts", id, {
			data: { body: blocks("Other writer") },
			_rev: current.data!._rev,
		});
		await editBody(editor, element, "Second edit. ");
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saveConflict));
		expect((await currentDraft()).body).toEqual(blocks("Other writer"));
		document.querySelector<HTMLButtonElement>("#emdash-tb-publish")!.click();
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saveConflict));
		expect(publishes).toBe(0);
	});

	it("saves a trailing Portable Text edit after an in-flight save before publishing", async () => {
		const { editor, element } = await mountPortableText();
		let releaseSave!: () => void;
		saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		await editBody(editor, element, "First edit. ");
		await vi.waitFor(() => expect(writes).toHaveLength(1));
		await editBody(editor, element, "Second edit. ");
		expect(writes).toHaveLength(1);
		releaseSave();
		await vi.waitFor(async () =>
			expect(JSON.stringify((await currentDraft()).body)).toContain("Second edit. First edit."),
		);
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saved));
		expect(writes).toHaveLength(2);
		expect(writes[1]!._rev).not.toBe(writes[0]!._rev);
		document.querySelector<HTMLButtonElement>("#emdash-tb-publish")!.click();
		await vi.waitFor(async () =>
			expect((await runtime.handleContentGet("posts", id)).data!.item.status).toBe("published"),
		);
	});

	it("keeps pagehide saves revision-guarded without blind retries", async () => {
		const { editor, element } = await mountPortableText();
		await editBody(editor, element, "First edit. ");
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saved));
		const current = await runtime.handleContentGet("posts", id);
		await runtime.handleContentUpdate("posts", id, {
			data: { body: blocks("Other writer") },
			_rev: current.data!._rev,
		});
		await act(async () => {
			editor.commands.insertContentAt(1, "Pagehide edit. ");
			window.dispatchEvent(new Event("pagehide"));
		});
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saveConflict));
		expect((await currentDraft()).body).toEqual(blocks("Other writer"));
		expect(writes).toHaveLength(2);
	});

	it("publishes unchanged content after an inline edit is undone", async () => {
		const { editor } = await mountPortableText();
		await act(async () => {
			editor.commands.insertContentAt(1, "Undone edit. ");
			editor.commands.undo();
		});
		document.querySelector<HTMLButtonElement>("#emdash-tb-publish")!.click();
		await vi.waitFor(async () =>
			expect((await runtime.handleContentGet("posts", id)).data!.item.status).toBe("published"),
		);
		expect(writes).toHaveLength(0);
	});

	it("publishes the visible undo when an older inline save is still pending", async () => {
		const { editor, element } = await mountPortableText(true);
		let releaseSave!: () => void;
		saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		try {
			await editBody(editor, element, "Undone edit. ");
			await vi.waitFor(() => expect(writes).toHaveLength(1));
			await act(async () => {
				editor.commands.undo();
			});
			document.querySelector<HTMLButtonElement>("#emdash-tb-publish")!.click();
			releaseSave();
			await vi.waitFor(async () =>
				expect((await runtime.handleContentGet("posts", id)).data!.item.status).toBe("published"),
			);
			const publishedBody = JSON.stringify(
				(await runtime.handleContentGet("posts", id)).data!.item.data.body,
			);
			expect(publishedBody).toContain("Stored body");
			expect(publishedBody).not.toContain("Undone edit.");
		} finally {
			releaseSave();
		}
	});

	it("publishes unchanged content after raw text editing is cancelled", async () => {
		const element = mount("title");
		await startEditing(element);
		element.textContent = "Cancelled edit";
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		document.querySelector<HTMLButtonElement>("#emdash-tb-publish")!.click();
		await vi.waitFor(async () =>
			expect((await runtime.handleContentGet("posts", id)).data!.item.status).toBe("published"),
		);
		expect(writes).toHaveLength(0);
	});

	it("retries a transient raw content read without reporting a revision conflict", async () => {
		const element = mount("title");
		readFailure = 500;
		element.click();
		await vi.waitFor(() => expect(saveMessage()).toBe(LABELS.saveFailed));
		expect(saveMessage()).not.toContain(LABELS.saveConflict);
		readFailure = undefined;
		await startEditing(element);
		finishEditing(element, "Recovered edit");
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saved));
		expect((await currentDraft()).title).toBe("Recovered edit");
	});

	it("publishes clean legacy annotations without requiring a template change", async () => {
		mount("title", false);
		document.querySelector<HTMLButtonElement>("#emdash-tb-publish")!.click();
		await vi.waitFor(async () =>
			expect((await runtime.handleContentGet("posts", id)).data!.item.status).toBe("published"),
		);
		expect(writes).toHaveLength(0);
	});

	it("sends the first pagehide edit using the rendered revision without waiting for a read", async () => {
		const { editor } = await mountPortableText();
		let releaseRead!: () => void;
		readGate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		try {
			await act(async () => {
				editor.commands.insertContentAt(1, "Immediate edit. ");
				window.dispatchEvent(new Event("pagehide"));
			});
			await vi.waitFor(() => expect(writes).toHaveLength(1));
			await vi.waitFor(async () =>
				expect(JSON.stringify((await currentDraft()).body)).toContain("Immediate edit."),
			);
		} finally {
			releaseRead();
		}
	});

	it("serializes a trailing pagehide edit after its pending save", async () => {
		const { editor, element } = await mountPortableText();
		let releaseSave!: () => void;
		saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		try {
			await editBody(editor, element, "First edit. ");
			await vi.waitFor(() => expect(writes).toHaveLength(1));
			await act(async () => {
				editor.commands.insertContentAt(1, "Latest edit. ");
				window.dispatchEvent(new Event("pagehide"));
			});
			expect(writes).toHaveLength(1);
			releaseSave();
			await vi.waitFor(async () =>
				expect(JSON.stringify((await currentDraft()).body)).toContain("Latest edit. First edit."),
			);
			expect(writes).toHaveLength(2);
			expect(writes[1]!._rev).not.toBe(writes[0]!._rev);
		} finally {
			releaseSave();
		}
	});

	it("retries a legacy Portable Text read before enabling editing", async () => {
		readFailure = 500;
		const { editor, element } = await mountPortableText(false);
		await vi.waitFor(() => expect(saveMessage()).toBe(LABELS.saveFailed));
		expect(editor.isEditable).toBe(false);
		expect(saveMessage()).not.toContain(LABELS.saveConflict);
		readFailure = undefined;
		await act(async () => element.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		await vi.waitFor(() => expect(editor.isEditable).toBe(true));
		await editBody(editor, element, "Recovered edit. ");
		await vi.waitFor(async () =>
			expect(JSON.stringify((await currentDraft()).body)).toContain("Recovered edit."),
		);
	});

	it("does not overwrite another inline instance's newer edit to the same field", async () => {
		const { editor, element } = await mountPortableText(true, 2);
		const secondElement = document.querySelectorAll<HTMLElement>(".ProseMirror")[1]!;
		const secondEditor = (secondElement as HTMLElement & { editor: Editor }).editor;
		await editBody(editor, element, "First instance. ");
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saved));
		await editBody(secondEditor, secondElement, "Stale second instance. ");
		await vi.waitFor(() => expect(saveMessage()).toContain(LABELS.saveConflict));
		expect(JSON.stringify((await currentDraft()).body)).toContain("First instance.");
		expect(JSON.stringify((await currentDraft()).body)).not.toContain("Stale second instance.");
		expect(writes).toHaveLength(1);
	});
});
