import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { createEditorialCommentsExtension } from "../../../src/components/editor/EditorialCommentsExtension";
import { PORTABLE_TEXT_KEY_ATTR } from "../../../src/components/editor/portableTextIdentity";
import { useEditorialComments } from "../../../src/components/editorial/useEditorialComments";
import {
	fetchEditorialThreads,
	updateEditorialAnchors,
	type EditorialThread,
} from "../../../src/lib/api/editorial-threads";

vi.mock("../../../src/lib/api/editorial-threads.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/lib/api/editorial-threads.js")>()),
	fetchEditorialThreads: vi.fn(),
	updateEditorialAnchors: vi.fn(async () => ({ updated: 1 })),
}));

const entry = { collection: "posts", id: "item-1" };

/** A text thread whose quote is no longer in the document, so its anchor needs storing as orphaned. */
const lostThread: EditorialThread = {
	id: "thread-1",
	collection: "posts",
	entryId: "item-1",
	anchor: {
		type: "text",
		field: "content",
		blockKey: "b1",
		start: 0,
		end: 4,
		quote: "gone",
		prefix: "",
		suffix: "",
	},
	anchorState: "attached",
	status: "open",
	createdBy: "u-2",
	resolvedBy: null,
	resolvedAt: null,
	createdAt: "2025-01-15T10:30:00Z",
	updatedAt: "2025-01-15T10:30:00Z",
	comments: [],
	can: { resolve: true, delete: false },
};

/** An open thread on "brown" in "The quick brown fox", in block `b1`. */
const brownThread: EditorialThread = {
	...lostThread,
	id: "thread-2",
	anchor: {
		type: "text",
		field: "content",
		blockKey: "b1",
		start: 10,
		end: 15,
		quote: "brown",
		prefix: "The quick ",
		suffix: " fox",
	},
};

const KeyAttribute = Extension.create({
	name: "testPortableTextKey",
	addGlobalAttributes() {
		return [
			{
				types: ["paragraph"],
				attributes: { [PORTABLE_TEXT_KEY_ATTR]: { default: null, rendered: false } },
			},
		];
	},
});

let editor: Editor | null = null;

afterEach(() => {
	editor?.destroy();
	editor = null;
	vi.clearAllMocks();
});

async function renderComments(canEdit: boolean, thread: EditorialThread = lostThread) {
	vi.mocked(fetchEditorialThreads).mockResolvedValue([thread]);
	editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit, KeyAttribute, createEditorialCommentsExtension({ current: {} })],
		content: {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { [PORTABLE_TEXT_KEY_ATTR]: "b1" },
					content: [{ type: "text", text: "The quick brown fox" }],
				},
			],
		},
	});
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<I18nProvider i18n={i18n}>{children}</I18nProvider>
		</QueryClientProvider>
	);
	const { result, rerender } = await renderHook(
		(props: { rev: string; isDirty: boolean } = { rev: "rev-1", isDirty: false }) =>
			useEditorialComments({
				entry,
				editor: editor as never,
				rev: props.rev,
				isDirty: props.isDirty,
				open: false,
				canEdit,
			}),
		{ wrapper },
	);
	await vi.waitFor(() => expect(result.current.threads).toHaveLength(1));
	await vi.waitFor(() =>
		expect(result.current.highlights.length).toBe(thread === lostThread ? 0 : 1),
	);
	/** Stands in for an edit followed by a save that returns a new revision. */
	const save = async (edit: (ed: Editor) => void) => {
		await rerender({ rev: "rev-1", isDirty: true });
		edit(editor!);
		await rerender({ rev: "rev-2", isDirty: false });
	};
	return { save };
}

describe("useEditorialComments anchor sync", () => {
	it("stores a lost anchor as orphaned for someone who may edit the entry", async () => {
		await renderComments(true);

		await vi.waitFor(() =>
			expect(vi.mocked(updateEditorialAnchors)).toHaveBeenCalledWith(entry, {
				_rev: "rev-1",
				anchors: [{ threadId: "thread-1", anchor: lostThread.anchor, anchorState: "orphaned" }],
			}),
		);
	});

	it("sends the moved offsets with the saved revision", async () => {
		const { save } = await renderComments(true, brownThread);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(vi.mocked(updateEditorialAnchors)).not.toHaveBeenCalled();

		await save((ed) => ed.commands.insertContentAt(1, "Look! "));

		await vi.waitFor(() =>
			expect(vi.mocked(updateEditorialAnchors)).toHaveBeenCalledWith(entry, {
				_rev: "rev-2",
				anchors: [
					{
						threadId: "thread-2",
						anchor: { ...brownThread.anchor, start: 16, end: 21, prefix: "Look! The quick " },
						anchorState: "attached",
					},
				],
			}),
		);
		expect(vi.mocked(updateEditorialAnchors)).toHaveBeenCalledTimes(1);
	});

	it("keeps a thread attached when its text is deleted and the deletion undone", async () => {
		const { save } = await renderComments(true, brownThread);

		await save((ed) => {
			ed.commands.deleteRange({ from: 11, to: 16 });
			ed.commands.undo();
		});
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(editor!.state.doc.textContent).toBe("The quick brown fox");
		expect(vi.mocked(updateEditorialAnchors)).not.toHaveBeenCalled();
	});

	it("orphans a thread whose text was deleted before a save", async () => {
		const { save } = await renderComments(true, brownThread);

		await save((ed) => ed.commands.deleteRange({ from: 11, to: 16 }));

		await vi.waitFor(() =>
			expect(vi.mocked(updateEditorialAnchors)).toHaveBeenCalledWith(entry, {
				_rev: "rev-2",
				anchors: [{ threadId: "thread-2", anchor: brownThread.anchor, anchorState: "orphaned" }],
			}),
		);
	});

	it("leaves anchors alone for someone who can't edit the entry", async () => {
		await renderComments(false);
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(vi.mocked(updateEditorialAnchors)).not.toHaveBeenCalled();
	});
});
