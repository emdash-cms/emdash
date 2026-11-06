import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import {
	anchorForRange,
	anchorForSelection,
	createEditorialCommentsExtension,
	getEditorialHighlights,
	locateAnchor,
	setEditorialHighlights,
} from "../../src/components/editor/EditorialCommentsExtension";
import { PORTABLE_TEXT_KEY_ATTR } from "../../src/components/editor/portableTextIdentity";
import type { EditorialTextAnchor } from "../../src/editorial-anchors";

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

function createEditor(paragraphs: Array<{ key: string | null; content: unknown[] }>) {
	editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit, KeyAttribute, createEditorialCommentsExtension({ current: {} })],
		content: {
			type: "doc",
			content: paragraphs.map((paragraph) => ({
				type: "paragraph",
				attrs: { [PORTABLE_TEXT_KEY_ATTR]: paragraph.key },
				content: paragraph.content,
			})),
		},
	});
	return editor;
}

afterEach(() => {
	editor?.destroy();
	editor = null;
});

const text = (value: string) => ({ type: "text", text: value });

describe("editorial comment highlights", () => {
	it("finds a text anchor after a hard break, by the text Portable Text stores", () => {
		const ed = createEditor([
			{ key: "b1", content: [text("Line one"), { type: "hardBreak" }, text("line two")] },
		]);
		const anchor: EditorialTextAnchor = {
			type: "text",
			field: "content",
			blockKey: "b1",
			start: 9,
			end: 13,
			quote: "line",
			prefix: "Line one\n",
			suffix: " two",
		};

		const range = locateAnchor(ed.state.doc, anchor);

		expect(range).not.toBeNull();
		expect(ed.state.doc.textBetween(range!.from, range!.to)).toBe("line");
	});

	it("finds a quote in content saved without block keys, without storing a stand-in key", () => {
		const ed = createEditor([{ key: null, content: [text("The quick brown fox")] }]);
		const anchor: EditorialTextAnchor = {
			type: "text",
			field: "content",
			blockKey: "gone",
			start: 4,
			end: 9,
			quote: "quick",
			prefix: "The ",
			suffix: " brown fox",
		};

		const range = locateAnchor(ed.state.doc, anchor);

		expect(ed.state.doc.textBetween(range!.from, range!.to)).toBe("quick");
		expect(anchorForRange(ed.state.doc, "content", range!.from, range!.to)).toBeNull();
	});

	it("moves a highlight with text typed before it", () => {
		const ed = createEditor([{ key: "b1", content: [text("The quick brown fox")] }]);
		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", kind: "text", from: 5, to: 10 }],
		});

		ed.commands.insertContentAt(1, "See: ");

		const [highlight] = getEditorialHighlights(ed.state);
		expect(ed.state.doc.textBetween(highlight!.from, highlight!.to)).toBe("quick");
	});

	it("drops a highlight whose text is deleted", () => {
		const ed = createEditor([{ key: "b1", content: [text("The quick brown fox")] }]);
		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", kind: "text", from: 5, to: 10 }],
		});

		ed.commands.deleteRange({ from: 4, to: 11 });

		expect(getEditorialHighlights(ed.state)).toEqual([]);
	});

	it("keys an unsaved block so the new anchor survives the next save", () => {
		const ed = createEditor([{ key: null, content: [text("Fresh paragraph")] }]);
		ed.commands.setTextSelection({ from: 7, to: 16 });

		const result = anchorForSelection(ed.state, ed.view.dispatch, "content", () => "new1");

		expect(result).toMatchObject({
			ok: true,
			anchor: { blockKey: "new1", start: 6, end: 15, quote: "paragraph", prefix: "Fresh " },
		});
		expect(ed.state.doc.firstChild!.attrs[PORTABLE_TEXT_KEY_ATTR]).toBe("new1");
	});

	it("refuses a selection across blocks", () => {
		const ed = createEditor([
			{ key: "b1", content: [text("One")] },
			{ key: "b2", content: [text("Two")] },
		]);
		ed.commands.setTextSelection({ from: 2, to: 7 });

		expect(anchorForSelection(ed.state, ed.view.dispatch, "content", () => "x")).toEqual({
			ok: false,
			reason: "multiple-blocks",
		});
	});
});
