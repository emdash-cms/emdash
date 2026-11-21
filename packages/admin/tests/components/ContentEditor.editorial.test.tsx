/**
 * Editorial comments in the entry editor with real Portable Text editors, for
 * what depends on an editor's selection, highlights and read-only state.
 */

import { Toasty } from "@cloudflare/kumo";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
	ContentEditor,
	type ContentEditorProps,
	type FieldDescriptor,
} from "../../src/components/ContentEditor";
import type { ContentItem } from "../../src/lib/api";
import {
	createEditorialThread,
	fetchEditorialThreads,
	type EditorialThread,
} from "../../src/lib/api/editorial-threads.js";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, search: _search, ...props }: any) => <a {...props}>{children}</a>,
		useBlocker: () => ({ status: "idle" }),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
	};
});

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => null,
	useHasApplicableTaxonomies: () => false,
}));

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/lib/api/editorial-threads.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/editorial-threads.js");
	return {
		...actual,
		fetchEditorialThreads: vi.fn(async () => []),
		createEditorialThread: vi.fn(),
		updateEditorialAnchors: vi.fn(async () => ({ updated: 0 })),
	};
});

const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const COMMENT_SHORTCUT = MAC ? "{Meta>}{Alt>}m{/Alt}{/Meta}" : "{Control>}{Alt>}m{/Alt}{/Control}";

function paragraph(key: string, text: string) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		children: [{ _type: "span", _key: `${key}-s`, text }],
	};
}

function makeItem(data: Record<string, unknown>): ContentItem {
	return {
		id: "item-1",
		type: "posts",
		slug: "my-post",
		status: "draft",
		data: { title: "My Post", ...data },
		authorId: "u-2",
		createdAt: "2025-01-15T10:30:00Z",
		updatedAt: "2025-01-15T10:30:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
		_rev: "rev-1",
	};
}

function textThread(
	id: string,
	field: string,
	quote: string,
	prefix: string,
	overrides: Partial<EditorialThread> = {},
): EditorialThread {
	return {
		id,
		collection: "posts",
		entryId: "item-1",
		anchor: {
			type: "text",
			field,
			blockKey: "b1",
			start: prefix.length,
			end: prefix.length + quote.length,
			quote,
			prefix,
			suffix: "",
		},
		anchorState: "attached",
		status: "open",
		createdBy: "u-2",
		resolvedBy: null,
		resolvedAt: null,
		createdAt: "2025-01-15T10:30:00Z",
		updatedAt: "2025-01-15T10:30:00Z",
		comments: [
			{
				id: `${id}-c1`,
				threadId: id,
				author: { id: "u-2", name: "Sam Rivera", avatarUrl: null },
				body: `About ${quote}`,
				createdAt: "2025-01-15T10:30:00Z",
				editedAt: null,
				deletedAt: null,
				can: { edit: false, delete: false },
			},
		],
		mentions: [],
		can: { resolve: true, delete: false },
		...overrides,
	};
}

async function renderEntry({
	fields,
	data,
	threads = [],
	...props
}: Partial<ContentEditorProps> & {
	fields: Record<string, FieldDescriptor>;
	data: Record<string, unknown>;
	threads?: EditorialThread[];
}) {
	vi.mocked(fetchEditorialThreads).mockResolvedValue(threads);
	const item = makeItem(data);
	const onSave = vi.fn();
	const element = (extra: Partial<ContentEditorProps>) => (
		<ContentEditor
			collection="posts"
			collectionLabel="Post"
			fields={{ title: { kind: "string", label: "Title" }, ...fields }}
			isNew={false}
			item={item}
			onSave={onSave}
			currentUser={{ id: "u-1", role: 50 }}
			{...props}
			{...extra}
		/>
	);
	const screen = await render(element({}), { wrapper: Toasty });
	await vi.waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
	/** Shows the same editor with other props, as navigating within the admin does. */
	const navigate = (extra: Partial<ContentEditorProps>) => screen.rerender(element(extra));
	return Object.assign(screen, { navigate });
}

/** The Tiptap editor behind a Portable Text field, which Tiptap keeps on its element. */
function editorFor(label: string): { editor: Editor; dom: HTMLElement } {
	const dom = [...document.querySelectorAll<HTMLElement>(".ProseMirror")].find((element) =>
		element
			.getAttribute("aria-labelledby")
			?.split(" ")
			.some((id) => {
				return document.getElementById(id)?.textContent === label;
			}),
	);
	if (!dom) throw new Error(`No editor labelled ${label}`);
	return { editor: (dom as HTMLElement & { editor: Editor }).editor, dom };
}

function selectText(editor: Editor, text: string) {
	let range: { from: number; to: number } | null = null;
	editor.state.doc.descendants((node, pos) => {
		if (range || !node.isText) return;
		const index = node.text!.indexOf(text);
		if (index >= 0) range = { from: pos + index, to: pos + index + text.length };
	});
	editor.commands.setTextSelection(range!);
}

async function waitForSelectionToolbar(name: string): Promise<HTMLElement> {
	let toolbar: HTMLElement | null = null;
	await vi.waitFor(
		() => {
			toolbar = document.querySelector<HTMLElement>(`[role="toolbar"][aria-label="${name}"]`);
			expect(toolbar).not.toBeNull();
		},
		{ timeout: 3000 },
	);
	return toolbar!;
}

beforeEach(async () => {
	await userEvent.cleanup();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("editorial comments in Portable Text fields", () => {
	it("comments on text in a Portable Text field that isn't called content", async () => {
		vi.mocked(createEditorialThread).mockImplementation(async (_entry, input) => ({
			...textThread("thread-new", "body", "brown", "The quick "),
			anchor: input.anchor,
		}));
		const screen = await renderEntry({
			fields: { body: { kind: "portableText", label: "Body" } },
			data: { body: [paragraph("b1", "The quick brown fox")] },
		});
		const { editor, dom } = editorFor("Body");
		dom.focus();
		selectText(editor, "brown");
		const toolbar = await waitForSelectionToolbar("Format selection");

		toolbar.querySelector<HTMLElement>('[aria-label="Comment"]')!.click();
		const margin = screen.getByRole("complementary", { name: "Comments" });
		await expect.element(margin.getByText("brown", { exact: true })).toBeVisible();
		await margin.getByRole("combobox", { name: "Comment" }).fill("Which brown?");
		await margin.getByRole("button", { name: "Comment", exact: true }).last().click();

		await vi.waitFor(() =>
			expect(vi.mocked(createEditorialThread)).toHaveBeenCalledWith(
				expect.objectContaining({ id: "item-1" }),
				expect.objectContaining({
					anchor: expect.objectContaining({
						type: "text",
						field: "body",
						blockKey: "b1",
						quote: "brown",
					}),
				}),
			),
		);
		await vi.waitFor(() =>
			expect(dom.querySelector('[data-editorial-thread="thread-new"]')?.textContent).toBe("brown"),
		);
	});

	it("keeps each field's threads and comments in its own editor", async () => {
		vi.mocked(createEditorialThread).mockResolvedValue(
			textThread("thread-new", "summary", "short", "A "),
		);
		const screen = await renderEntry({
			fields: {
				content: { kind: "portableText", label: "Content" },
				summary: { kind: "portableText", label: "Summary" },
			},
			data: {
				content: [paragraph("b1", "The quick brown fox")],
				summary: [paragraph("b1", "A short summary")],
			},
			threads: [textThread("thread-summary", "summary", "summary", "A short ")],
		});
		const summary = editorFor("Summary");
		const content = editorFor("Content");

		await vi.waitFor(() =>
			expect(
				summary.dom.querySelector('[data-editorial-thread="thread-summary"]')?.textContent,
			).toBe("summary"),
		);
		expect(content.dom.querySelector("[data-editorial-thread]")).toBeNull();

		summary.dom.focus();
		selectText(summary.editor, "short");
		await userEvent.keyboard(COMMENT_SHORTCUT);
		const margin = screen.getByRole("complementary", { name: "Comments" });
		await margin.getByRole("combobox", { name: "Comment" }).fill("Shorter still");
		await margin.getByRole("button", { name: "Comment", exact: true }).last().click();

		await vi.waitFor(() =>
			expect(vi.mocked(createEditorialThread)).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					anchor: expect.objectContaining({ field: "summary", quote: "short" }),
				}),
			),
		);
	});

	it("shows a resolved thread whose text is still there as attached", async () => {
		const screen = await renderEntry({
			fields: { content: { kind: "portableText", label: "Content" } },
			data: { content: [paragraph("b1", "The quick brown fox")] },
			threads: [
				textThread("thread-open", "content", "fox", "The quick brown "),
				textThread("thread-kept", "content", "quick", "The ", { status: "resolved" }),
				textThread("thread-gone", "content", "slow", "The ", { status: "resolved" }),
			],
		});
		await screen.getByRole("button", { name: "Show comments" }).click();
		const margin = screen.getByRole("complementary", { name: "Comments" });

		await margin.getByRole("button", { name: "Show resolved" }).click();

		const card = (id: string) =>
			margin.element().querySelector<HTMLElement>(`[data-editorial-thread-card="${id}"]`);
		await vi.waitFor(() => expect(card("thread-kept")).not.toBeNull());
		expect(card("thread-kept")!.textContent).not.toContain("Detached");
		expect(card("thread-gone")!.textContent).toContain("Detached");
	});
});

describe("editorial comments without edit access", () => {
	const fields = { content: { kind: "portableText", label: "Content" } } as const;
	const data = { content: [paragraph("b1", "The quick brown fox")] };

	it("lets someone viewing an entry another person has locked comment on a selection", async () => {
		vi.mocked(createEditorialThread).mockResolvedValue(
			textThread("thread-new", "content", "quick", "The "),
		);
		const screen = await renderEntry({ fields, data, readOnly: true });
		const { editor, dom } = editorFor("Content");
		expect(editor.isEditable).toBe(false);

		dom.focus();
		selectText(editor, "quick");
		const toolbar = await waitForSelectionToolbar("Selection actions");
		expect(toolbar.querySelectorAll("button")).toHaveLength(1);
		toolbar.querySelector<HTMLElement>('[aria-label="Comment"]')!.click();

		const margin = screen.getByRole("complementary", { name: "Comments" });
		await margin.getByRole("combobox", { name: "Comment" }).fill("Faster?");
		await margin.getByRole("button", { name: "Comment", exact: true }).last().click();
		await vi.waitFor(() =>
			expect(vi.mocked(createEditorialThread)).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					anchor: expect.objectContaining({ field: "content", blockKey: "b1", quote: "quick" }),
				}),
			),
		);
		expect(editor.state.doc.textContent).toBe("The quick brown fox");
	});

	it("lets a Contributor start a comment on a selection with the shortcut", async () => {
		const screen = await renderEntry({
			fields,
			data,
			readOnly: true,
			currentUser: { id: "u-3", role: 20 },
		});
		const { editor, dom } = editorFor("Content");

		dom.focus();
		selectText(editor, "brown");
		await userEvent.keyboard(COMMENT_SHORTCUT);

		const margin = screen.getByRole("complementary", { name: "Comments" });
		await expect.element(margin.getByRole("combobox", { name: "Comment" })).toHaveFocus();
		await expect.element(margin.getByText("brown", { exact: true })).toBeVisible();
	});

	it("explains why a block saved without a key can't take a comment yet", async () => {
		const screen = await renderEntry({
			fields,
			data: {
				content: [
					{
						_type: "block",
						style: "normal",
						children: [{ _type: "span", text: "The quick brown fox" }],
					},
				],
			},
			readOnly: true,
		});
		const { editor, dom } = editorFor("Content");

		dom.focus();
		selectText(editor, "brown");
		await userEvent.keyboard(COMMENT_SHORTCUT);

		const margin = screen.getByRole("complementary", { name: "Comments" });
		await expect.element(margin.getByText("This block can’t take a comment yet")).toBeVisible();
		expect(margin.getByRole("combobox", { name: "Comment" }).query()).toBeNull();
	});
});

describe("editorial comments on blocks", () => {
	const fields = { content: { kind: "portableText", label: "Content" } } as const;
	const data = {
		content: [
			paragraph("b1", "Before the divider"),
			{ _type: "break", _key: "hr1", style: "lineBreak" },
			paragraph("b2", "After the divider"),
		],
	};

	it("starts a block comment on a selected divider", async () => {
		vi.mocked(createEditorialThread).mockImplementation(async (_entry, input) => ({
			...textThread("thread-new", "content", "x", ""),
			anchor: input.anchor,
		}));
		const screen = await renderEntry({ fields, data });
		const { editor, dom } = editorFor("Content");
		let dividerPos = -1;
		editor.state.doc.forEach((node, offset) => {
			if (node.type.name === "horizontalRule") dividerPos = offset;
		});

		dom.focus();
		editor.commands.setNodeSelection(dividerPos);
		await userEvent.keyboard(COMMENT_SHORTCUT);
		const margin = screen.getByRole("complementary", { name: "Comments" });
		await margin.getByRole("combobox", { name: "Comment" }).fill("Drop this?");
		await margin.getByRole("button", { name: "Comment", exact: true }).last().click();

		await vi.waitFor(() =>
			expect(vi.mocked(createEditorialThread)).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					anchor: { type: "block", field: "content", blockKey: "hr1" },
				}),
			),
		);
		await vi.waitFor(() =>
			expect(dom.querySelector('hr[data-editorial-thread="thread-new"]')).not.toBeNull(),
		);
	});

	it("opens a block thread from its highlighted block", async () => {
		const blockThread: EditorialThread = {
			...textThread("thread-hr", "content", "x", ""),
			anchor: { type: "block", field: "content", blockKey: "hr1" },
		};
		const screen = await renderEntry({ fields, data, threads: [blockThread] });
		const { dom } = editorFor("Content");
		let divider: HTMLElement | null = null;
		await vi.waitFor(() => {
			divider = dom.querySelector<HTMLElement>('[data-editorial-thread="thread-hr"]');
			expect(divider?.classList.contains("emdash-editorial-block")).toBe(true);
		});

		await userEvent.click(divider!);

		const margin = screen.getByRole("complementary", { name: "Comments" });
		await expect.element(margin.getByRole("combobox", { name: "Reply" })).toBeVisible();
	});
});

describe("editorial comment links", () => {
	const fields = { content: { kind: "portableText", label: "Content" } } as const;
	const data = { content: [paragraph("b1", "The quick brown fox")] };

	/** Records what is scrolled into view while `run` runs. */
	async function scrolledDuring(run: () => Promise<void>): Promise<Element[]> {
		const scrolled: Element[] = [];
		const spy = vi
			.spyOn(Element.prototype, "scrollIntoView")
			.mockImplementation(function (this: Element) {
				scrolled.push(this);
			});
		try {
			await run();
		} finally {
			spy.mockRestore();
		}
		return scrolled;
	}

	it("opens the margin on a thread linked after the entry is already shown, at its text", async () => {
		const screen = await renderEntry({
			fields,
			data,
			threads: [textThread("thread-1", "content", "quick", "The ")],
		});
		expect(screen.getByRole("complementary", { name: "Comments" }).query()).toBeNull();
		const { dom } = editorFor("Content");

		const scrolled = await scrolledDuring(async () => {
			await screen.navigate({ initialThreadId: "thread-1" });
			const margin = screen.getByRole("complementary", { name: "Comments" });
			await expect.element(margin.getByRole("combobox", { name: "Reply" })).toBeVisible();
			await vi.waitFor(() =>
				expect(dom.querySelector('[data-editorial-thread="thread-1"]')).not.toBeNull(),
			);
		});

		expect(scrolled.some((element) => dom.contains(element))).toBe(true);
	});

	it("selects a thread's text from its card", async () => {
		const screen = await renderEntry({
			fields,
			data,
			threads: [textThread("thread-1", "content", "quick", "The ")],
			initialThreadId: "thread-1",
		});
		const { editor, dom } = editorFor("Content");
		const margin = screen.getByRole("complementary", { name: "Comments" });

		await margin.getByRole("button", { name: "Go to text" }).click();

		const { from, to } = editor.state.selection;
		expect(editor.state.doc.textBetween(from, to)).toBe("quick");
		expect(dom.contains(document.activeElement)).toBe(true);
	});
});

describe("editorial comment composer", () => {
	const fields = { content: { kind: "portableText", label: "Content" } } as const;
	const data = { content: [paragraph("b1", "The quick brown fox")] };

	it("sends a comment once when the shortcut is pressed again while it saves", async () => {
		vi.mocked(createEditorialThread).mockReturnValue(new Promise(() => undefined));
		const screen = await renderEntry({ fields, data });
		const { editor, dom } = editorFor("Content");

		dom.focus();
		selectText(editor, "quick");
		await userEvent.keyboard(COMMENT_SHORTCUT);
		const margin = screen.getByRole("complementary", { name: "Comments" });
		await margin.getByRole("combobox", { name: "Comment" }).fill("Faster?");
		await userEvent.keyboard("{Control>}{Enter}{/Control}");
		await vi.waitFor(() => expect(vi.mocked(createEditorialThread)).toHaveBeenCalledTimes(1));
		await userEvent.keyboard("{Control>}{Enter}{/Control}");

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(vi.mocked(createEditorialThread)).toHaveBeenCalledTimes(1);
	});

	it("scrolls to a resolved thread's text when its card is opened", async () => {
		const screen = await renderEntry({
			fields,
			data,
			threads: [textThread("thread-kept", "content", "quick", "The ", { status: "resolved" })],
		});
		const { dom } = editorFor("Content");
		await screen.getByRole("button", { name: "Show comments" }).click();
		const margin = screen.getByRole("complementary", { name: "Comments" });
		await margin.getByRole("button", { name: "Show resolved" }).click();
		const scrolled: Element[] = [];
		const scrollIntoView = vi
			.spyOn(Element.prototype, "scrollIntoView")
			.mockImplementation(function (this: Element) {
				scrolled.push(this);
			});
		try {
			const card = await vi.waitFor(() => {
				const found = margin
					.element()
					.querySelector<HTMLElement>('[data-editorial-thread-card="thread-kept"]');
				expect(found).not.toBeNull();
				return found!;
			});
			card.click();

			await vi.waitFor(() => expect(scrolled.some((element) => dom.contains(element))).toBe(true));
		} finally {
			scrollIntoView.mockRestore();
		}
	});
});

describe("editorial block comments without edit access", () => {
	const fields = { content: { kind: "portableText", label: "Content" } } as const;
	const data = {
		content: [
			paragraph("b1", "Before the divider"),
			{ _type: "break", _key: "hr1", style: "lineBreak" },
			paragraph("b2", "After the divider"),
		],
	};

	it("offers Comment on a block selected in a read-only editor", async () => {
		const screen = await renderEntry({ fields, data, readOnly: true });
		const { dom } = editorFor("Content");

		await userEvent.click(dom.querySelector("hr")!);
		const toolbar = await waitForSelectionToolbar("Selection actions");
		expect(toolbar.querySelectorAll("button")).toHaveLength(1);
		toolbar.querySelector<HTMLElement>('[aria-label="Comment"]')!.click();

		const margin = screen.getByRole("complementary", { name: "Comments" });
		await expect.element(margin.getByRole("combobox", { name: "Comment" })).toHaveFocus();
		await margin.getByRole("combobox", { name: "Comment" }).fill("Drop this?");
		vi.mocked(createEditorialThread).mockImplementation(async (_entry, input) => ({
			...textThread("thread-new", "content", "x", ""),
			anchor: input.anchor,
		}));
		await margin.getByRole("button", { name: "Comment", exact: true }).last().click();
		await vi.waitFor(() =>
			expect(vi.mocked(createEditorialThread)).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ anchor: { type: "block", field: "content", blockKey: "hr1" } }),
			),
		);
	});
});

describe("editorial comment drafts", () => {
	const fields = { content: { kind: "portableText", label: "Content" } } as const;
	const data = { content: [paragraph("b1", "The quick brown fox")] };

	it("sends the selected text as edited while the comment was written", async () => {
		vi.mocked(createEditorialThread).mockImplementation(async (_entry, input) => ({
			...textThread("thread-new", "content", "x", ""),
			anchor: input.anchor,
		}));
		const screen = await renderEntry({ fields, data });
		const { editor, dom } = editorFor("Content");

		dom.focus();
		selectText(editor, "brown");
		await userEvent.keyboard(COMMENT_SHORTCUT);
		const margin = screen.getByRole("complementary", { name: "Comments" });
		await margin.getByRole("combobox", { name: "Comment" }).fill("Which shade?");
		let inside = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && inside < 0) inside = pos + node.text!.indexOf("brown") + 2;
		});
		editor.commands.insertContentAt(inside, "-");
		await margin.getByRole("button", { name: "Comment", exact: true }).last().click();

		await vi.waitFor(() =>
			expect(vi.mocked(createEditorialThread)).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					anchor: expect.objectContaining({ quote: "br-own", start: 10, end: 16 }),
				}),
			),
		);
	});
});
