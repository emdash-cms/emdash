import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { createEditorialCommentsExtension } from "../../../src/components/editor/EditorialCommentsExtension";
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

let editor: Editor | null = null;

afterEach(() => {
	editor?.destroy();
	editor = null;
	vi.clearAllMocks();
});

async function renderComments(canEdit: boolean) {
	vi.mocked(fetchEditorialThreads).mockResolvedValue([lostThread]);
	editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit, createEditorialCommentsExtension({ current: {} })],
		content: "<p>The quick brown fox</p>",
	});
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<I18nProvider i18n={i18n}>{children}</I18nProvider>
		</QueryClientProvider>
	);
	const { result } = await renderHook(
		() =>
			useEditorialComments({
				entry,
				editor: editor as never,
				rev: "rev-1",
				isDirty: false,
				open: false,
				canEdit,
			}),
		{ wrapper },
	);
	await vi.waitFor(() => expect(result.current.threads).toHaveLength(1));
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

	it("leaves anchors alone for someone who can't edit the entry", async () => {
		await renderComments(false);
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(vi.mocked(updateEditorialAnchors)).not.toHaveBeenCalled();
	});
});
