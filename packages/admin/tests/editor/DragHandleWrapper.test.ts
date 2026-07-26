import { Editor } from "@tiptap/core";
import { DragHandlePlugin, normalizeNestedOptions } from "@tiptap/extension-drag-handle";
import type { RuleContext } from "@tiptap/extension-drag-handle";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import {
	_dragHandleOffset,
	_getDragHandlePlacement,
	_nestedDragOptions,
	_rowsOnlyRule,
} from "../../src/components/editor/DragHandleWrapper";
import {
	NESTING_GUTTER_PX,
	NestingBlockExtension,
	NestingColumnExtension,
} from "../../src/components/editor/NestingBlockNode";

describe("DragHandleWrapper", () => {
	it("places controls at the admin UI's logical start edge", () => {
		expect(_getDragHandlePlacement("ltr")).toBe("left-start");
		expect(_getDragHandlePlacement("rtl")).toBe("right-start");
	});

	it("locks the real drag plugin through core transaction metadata", () => {
		const host = document.createElement("div");
		const editorElement = document.createElement("div");
		const dragElement = document.createElement("div");
		host.append(editorElement);
		document.body.append(host);
		const editor = new Editor({
			element: editorElement,
			extensions: [StarterKit],
			content: "<p>Test</p>",
		});
		const dragPlugin = DragHandlePlugin({
			editor,
			element: dragElement,
			nestedOptions: normalizeNestedOptions(false),
		});

		try {
			editor.registerPlugin(dragPlugin.plugin);
			expect(dragElement.draggable).toBe(true);

			editor.commands.setMeta("lockDragHandle", true);
			expect(dragElement.draggable).toBe(false);

			editor.commands.setMeta("lockDragHandle", false);
			expect(dragElement.draggable).toBe(true);
		} finally {
			dragPlugin.unbind();
			editor.destroy();
			host.remove();
		}
	});
});

/**
 * The draggable unit is a row, and these assert both halves of that claim.
 *
 * The rule replaces TipTap's default rules rather than joining them, so the tests
 * have to show that nothing the defaults guarded is lost: table internals and
 * inline content must still be excluded, by the rule rather than by assumption.
 * They also pin the behaviour outside a container, which enabling nested targeting
 * must not change.
 */
describe("rows are the draggable unit", () => {
	// Node views are React renderers and are not needed to exercise the schema.
	const Block = NestingBlockExtension.extend({ addNodeView: undefined });
	const Column = NestingColumnExtension.extend({ addNodeView: undefined });

	function withEditor(content: string, run: (editor: Editor) => void) {
		const host = document.createElement("div");
		document.body.append(host);
		const editor = new Editor({
			element: host,
			extensions: [StarterKit, Table, TableRow, TableHeader, TableCell, Block, Column],
			content,
		});
		try {
			run(editor);
		} finally {
			editor.destroy();
			host.remove();
		}
	}

	/** First position inside the first text node matching `text`. */
	function posInText(editor: Editor, text: string): number {
		let found = -1;
		editor.state.doc.descendants((node, pos) => {
			if (found === -1 && node.isText && node.text === text) found = pos + 1;
			return found === -1;
		});
		if (found === -1) throw new Error(`no text node matching ${text}`);
		return found;
	}

	function scoreAt(
		$pos: ReturnType<Editor["state"]["doc"]["resolve"]>,
		depth: number,
		view: unknown,
	) {
		const parent = $pos.node(depth - 1);
		const index = $pos.index(depth - 1);
		const context = {
			node: $pos.node(depth),
			pos: $pos.before(depth),
			depth,
			parent,
			index,
			isFirst: index === 0,
			isLast: index === parent.childCount - 1,
			$pos,
			view,
		} as unknown as RuleContext;
		return 1000 - _rowsOnlyRule.evaluate(context);
	}

	/** The node the handle targets: highest score, then deepest. */
	function targetFor(editor: Editor, text: string): string | null {
		const $pos = editor.state.doc.resolve(posInText(editor, text));
		const candidates = [];
		for (let depth = $pos.depth; depth >= 1; depth -= 1) {
			const score = scoreAt($pos, depth, editor.view);
			if (score > 0) candidates.push({ name: $pos.node(depth).type.name, depth, score });
		}
		candidates.sort((a, b) => b.score - a.score || b.depth - a.depth);
		return candidates[0]?.name ?? null;
	}

	const inColumn = (inner: string) =>
		`<div data-emdash-nesting-block><div data-emdash-nesting-column>${inner}</div></div>`;

	it("targets a list as one row, not its items, in the body", () => {
		// This is what the editor did before nested targeting was enabled. Picking
		// TipTap's defaults instead would target the item and make a list impossible
		// to move as a block anywhere in the document.
		withEditor("<ul><li><p>Top item</p></li></ul>", (editor) => {
			expect(targetFor(editor, "Top item")).toBe("bulletList");
		});
	});

	it("targets a list as one row inside a column too", () => {
		withEditor(inColumn("<ol><li><p>Column item</p></li></ol>"), (editor) => {
			expect(targetFor(editor, "Column item")).toBe("orderedList");
		});
	});

	it("targets a plain block in the body and in a column alike", () => {
		withEditor("<p>Loose</p>", (editor) => {
			expect(targetFor(editor, "Loose")).toBe("paragraph");
		});
		withEditor(inColumn("<p>In a column</p>"), (editor) => {
			expect(targetFor(editor, "In a column")).toBe("paragraph");
		});
	});

	it("targets a quote as one row, not the paragraph inside it", () => {
		withEditor("<blockquote><p>Quoted</p></blockquote>", (editor) => {
			expect(targetFor(editor, "Quoted")).toBe("blockquote");
		});
	});

	it("never targets table internals, which the default rules used to guard", () => {
		withEditor("<table><tbody><tr><td><p>Cell</p></td></tr></tbody></table>", (editor) => {
			// The table is the row; everything inside it is the row's structure.
			expect(targetFor(editor, "Cell")).toBe("table");
		});
	});

	it("never targets a column", () => {
		withEditor(inColumn("<p>In a column</p>"), (editor) => {
			const $pos = editor.state.doc.resolve(posInText(editor, "In a column"));
			// doc > nestingBlock(1) > nestingColumn(2) > paragraph(3)
			expect(scoreAt($pos, 2, editor.view)).toBeLessThanOrEqual(0);
			expect(scoreAt($pos, 1, editor.view)).toBeGreaterThan(0);
		});
	});

	it("offsets the handle into the row's own gutter when nested", () => {
		expect(_dragHandleOffset(false)).toBe(4);
		expect(_dragHandleOffset(true)).toBe(-(NESTING_GUTTER_PX - 4));
		expect(_dragHandleOffset(true) + NESTING_GUTTER_PX).toBe(4);
	});
});

describe("nested drag options", () => {
	const normalized = normalizeNestedOptions(_nestedDragOptions);

	it("replaces the default rules rather than joining them", () => {
		// Deliberate: the defaults resolve the unit inside a structure, this resolves
		// which structures are units. See _rowsOnlyRule for why both cannot hold.
		expect(normalized.defaultRules).toBe(false);
		expect(normalized.rules.map((rule) => rule.id)).toEqual(["emdashRowsOnly"]);
	});

	it("turns edge detection off", () => {
		expect(normalized.edgeDetection.edges).toEqual([]);
	});
});
