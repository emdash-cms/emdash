import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import {
	createEditorialCommentsExtension,
	getEditorialHighlights,
} from "../../../src/components/editor/EditorialCommentsExtension";
import { PORTABLE_TEXT_KEY_ATTR } from "../../../src/components/editor/portableTextIdentity";
import {
	editorialThreadsQueryKey,
	useEditorialComments,
} from "../../../src/components/editorial/useEditorialComments";
import {
	createEditorialThread,
	fetchEditorialThreads,
	updateEditorialAnchors,
	type EditorialEntry,
	type EditorialThread,
} from "../../../src/lib/api/editorial-threads";

vi.mock("../../../src/lib/api/editorial-threads.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/lib/api/editorial-threads.js")>()),
	fetchEditorialThreads: vi.fn(),
	createEditorialThread: vi.fn(),
	updateEditorialAnchors: vi.fn(async () => ({ updated: 1 })),
}));

const entry = { collection: "posts", id: "item-1" };
const otherEntry = { collection: "posts", id: "item-2" };

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

interface HookProps {
	rev: string;
	isDirty: boolean;
	entry: EditorialEntry;
	initialThreadId?: string;
}

async function renderComments(
	canEdit: boolean,
	threads: EditorialThread[] | Error = [lostThread],
	field = "content",
) {
	if (threads instanceof Error) vi.mocked(fetchEditorialThreads).mockRejectedValue(threads);
	else vi.mocked(fetchEditorialThreads).mockResolvedValue(threads);
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
	const editors = new Map([[field, editor as never]]);
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<I18nProvider i18n={i18n}>{children}</I18nProvider>
		</QueryClientProvider>
	);
	const initialProps: HookProps = { rev: "rev-1", isDirty: false, entry };
	let props = initialProps;
	const { result, rerender } = await renderHook(
		(current: HookProps = initialProps) =>
			useEditorialComments({
				entry: current.entry,
				editors,
				rev: current.rev,
				isDirty: current.isDirty,
				open: false,
				canEdit,
				initialThreadId: current.initialThreadId,
			}),
		{ wrapper },
	);
	const update = async (next: Partial<HookProps>) => {
		props = { ...props, ...next };
		await rerender(props);
	};
	/** Stands in for an edit followed by a save that returns a new revision. */
	const save = async (edit: (ed: Editor) => void) => {
		await update({ rev: "rev-1", isDirty: true });
		edit(editor!);
		await update({ rev: "rev-2", isDirty: false });
	};
	return { result, save, update, queryClient };
}

async function renderLoaded(canEdit: boolean, thread: EditorialThread = lostThread) {
	const rendered = await renderComments(canEdit, [thread]);
	await vi.waitFor(() => expect(rendered.result.current.threads).toHaveLength(1));
	await vi.waitFor(() =>
		expect(rendered.result.current.highlights.length).toBe(thread === lostThread ? 0 : 1),
	);
	return rendered;
}

const highlightedText = () =>
	getEditorialHighlights(editor!.state).map((highlight) =>
		editor!.state.doc.textBetween(highlight.from, highlight.to),
	);

describe("useEditorialComments anchor sync", () => {
	it("stores a lost anchor as orphaned for someone who may edit the entry", async () => {
		await renderLoaded(true);

		await vi.waitFor(() =>
			expect(vi.mocked(updateEditorialAnchors)).toHaveBeenCalledWith(entry, {
				_rev: "rev-1",
				anchors: [{ threadId: "thread-1", anchor: lostThread.anchor, anchorState: "orphaned" }],
			}),
		);
	});

	it("sends the moved offsets with the saved revision", async () => {
		const { save } = await renderLoaded(true, brownThread);
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

	it("keeps a highlight edited inside when the threads or the active thread change", async () => {
		const { result, update, queryClient } = await renderLoaded(true, brownThread);
		await update({ isDirty: true });
		editor!.commands.insertContentAt(13, "e");
		expect(highlightedText()).toEqual(["breown"]);

		await act(async () => result.current.setActiveThreadId("thread-2"));
		await act(async () => {
			queryClient.setQueryData(editorialThreadsQueryKey(entry), [{ ...brownThread }]);
		});
		await act(async () => result.current.setActiveThreadId(null));
		expect(highlightedText()).toEqual(["breown"]);
		await update({ rev: "rev-2", isDirty: false });

		await vi.waitFor(() =>
			expect(vi.mocked(updateEditorialAnchors)).toHaveBeenCalledWith(entry, {
				_rev: "rev-2",
				anchors: [
					{
						threadId: "thread-2",
						anchor: { ...brownThread.anchor, start: 10, end: 16, quote: "breown" },
						anchorState: "attached",
					},
				],
			}),
		);
	});

	it("keeps the highlight when the anchor it stored comes back after more edits", async () => {
		const { update, queryClient, save } = await renderLoaded(true, brownThread);
		vi.mocked(fetchEditorialThreads).mockReturnValue(new Promise(() => undefined));
		await save((ed) => ed.commands.insertContentAt(13, "e"));
		await vi.waitFor(() => expect(vi.mocked(fetchEditorialThreads)).toHaveBeenCalledTimes(2));
		await update({ isDirty: true });
		editor!.commands.insertContentAt(12, "a");
		expect(highlightedText()).toEqual(["bareown"]);

		await act(async () => {
			queryClient.setQueryData(editorialThreadsQueryKey(entry), [
				{ ...brownThread, anchor: { ...brownThread.anchor, end: 16, quote: "breown" } },
			]);
		});

		expect(highlightedText()).toEqual(["bareown"]);
	});

	it("keeps a thread attached when its text is deleted and the deletion undone", async () => {
		const { save } = await renderLoaded(true, brownThread);

		await save((ed) => {
			ed.commands.deleteRange({ from: 11, to: 16 });
			ed.commands.undo();
		});
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(editor!.state.doc.textContent).toBe("The quick brown fox");
		expect(vi.mocked(updateEditorialAnchors)).not.toHaveBeenCalled();
	});

	it("orphans a thread whose text was deleted before a save", async () => {
		const { save } = await renderLoaded(true, brownThread);

		await save((ed) => ed.commands.deleteRange({ from: 11, to: 16 }));

		await vi.waitFor(() =>
			expect(vi.mocked(updateEditorialAnchors)).toHaveBeenCalledWith(entry, {
				_rev: "rev-2",
				anchors: [{ threadId: "thread-2", anchor: brownThread.anchor, anchorState: "orphaned" }],
			}),
		);
	});

	it("leaves anchors alone for someone who can't edit the entry", async () => {
		await renderLoaded(false);
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(vi.mocked(updateEditorialAnchors)).not.toHaveBeenCalled();
	});

	it("highlights and syncs threads in a Portable Text field with another name", async () => {
		const bodyThread = { ...brownThread, anchor: { ...brownThread.anchor, field: "body" } };
		const { save, result } = await renderComments(true, [bodyThread], "body");
		await vi.waitFor(() => expect(result.current.highlights).toHaveLength(1));
		expect(result.current.highlights[0]).toMatchObject({ field: "body", threadId: "thread-2" });

		await save((ed) => ed.commands.insertContentAt(1, "Look! "));

		await vi.waitFor(() =>
			expect(vi.mocked(updateEditorialAnchors)).toHaveBeenCalledWith(entry, {
				_rev: "rev-2",
				anchors: [
					expect.objectContaining({
						anchor: expect.objectContaining({ field: "body", start: 16, end: 21 }),
						anchorState: "attached",
					}),
				],
			}),
		);
	});
});

describe("useEditorialComments resolution", () => {
	it("counts a resolved thread's anchor as found without highlighting it", async () => {
		const resolved: EditorialThread = { ...brownThread, status: "resolved" };
		const { result } = await renderComments(true, [resolved, lostThread]);

		await vi.waitFor(() => expect(result.current.attachedIds.has("thread-2")).toBe(true));
		expect(result.current.attachedIds.has("thread-1")).toBe(false);
		expect(result.current.highlights).toEqual([]);
	});
});

describe("useEditorialComments errors", () => {
	it("reports threads that couldn't be loaded", async () => {
		const { result } = await renderComments(true, new Error("Server unavailable"));

		await vi.waitFor(() => expect(result.current.loadError).toBe("load"));
		expect(result.current.threads).toEqual([]);
	});

	it("keeps the last threads when a refresh fails", async () => {
		const { result, queryClient } = await renderLoaded(true, brownThread);
		vi.mocked(fetchEditorialThreads).mockRejectedValue(new Error("Server unavailable"));

		await act(() => queryClient.refetchQueries({ queryKey: editorialThreadsQueryKey(entry) }));

		await vi.waitFor(() => expect(result.current.loadError).toBe("refresh"));
		expect(result.current.threads).toEqual([brownThread]);
	});
});

describe("useEditorialComments across entries", () => {
	it("drops an unfinished draft and opens the new entry's linked thread", async () => {
		const { result, update } = await renderLoaded(true, brownThread);
		await act(async () =>
			result.current.setDraft({ anchor: { type: "field", field: "title" }, range: null }),
		);

		await update({ entry: otherEntry, initialThreadId: "thread-9" });

		expect(result.current.draft).toBeNull();
		expect(result.current.activeThreadId).toBe("thread-9");
	});

	it("files a comment saved after leaving under its own entry", async () => {
		let finish!: (thread: EditorialThread) => void;
		vi.mocked(createEditorialThread).mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const { result, update, queryClient } = await renderLoaded(true, brownThread);
		await act(async () =>
			result.current.actions.createThread.mutate({ anchor: { type: "entry" }, body: "Hi" }),
		);
		await vi.waitFor(() => expect(vi.mocked(createEditorialThread)).toHaveBeenCalled());

		await update({ entry: otherEntry });
		const nextDraft = { anchor: { type: "entry" as const }, range: null };
		await act(async () => result.current.setDraft(nextDraft));
		const saved: EditorialThread = { ...lostThread, id: "thread-new", anchor: { type: "entry" } };
		await act(async () => finish(saved));

		await vi.waitFor(() =>
			expect(queryClient.getQueryData(editorialThreadsQueryKey(entry))).toContainEqual(saved),
		);
		expect(queryClient.getQueryData(editorialThreadsQueryKey(otherEntry))).not.toContainEqual(
			saved,
		);
		expect(result.current.draft).toBe(nextDraft);
		expect(result.current.activeThreadId).toBeNull();
	});
});
