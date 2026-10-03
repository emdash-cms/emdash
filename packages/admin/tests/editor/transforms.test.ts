/**
 * Block Transform Tests
 *
 * Tests that block transformations work correctly:
 * - Transform paragraph to headings (H1, H2, H3)
 * - Transform to blockquote, code block
 * - Transform to bullet and ordered lists
 * - Duplicate block preserves content
 * - Delete block removes content
 *
 * These transformations back the Turn into menus.
 */

import { Editor } from "@tiptap/core";
import TextAlign from "@tiptap/extension-text-align";
import StarterKit from "@tiptap/starter-kit";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	activeTextBlockType,
	canTurnInto,
	textBlockTypes,
	toggleTextBlockType,
} from "../../src/components/editor/blockTypes";

describe("Block Transforms", () => {
	let editor: Editor;

	beforeEach(() => {
		editor = new Editor({
			extensions: [
				StarterKit.configure({
					heading: { levels: [1, 2, 3] },
				}),
			],
			content: "<p>Test content</p>",
		});
	});

	afterEach(() => {
		editor.destroy();
	});

	describe("Transform to Paragraph", () => {
		it("transforms heading to paragraph", () => {
			editor.commands.setHeading({ level: 1 });
			expect(editor.isActive("heading", { level: 1 })).toBe(true);

			const transform = textBlockTypes.find((t) => t.id === "paragraph");
			transform?.transform(editor);

			expect(editor.isActive("heading")).toBe(false);
			expect(editor.isActive("paragraph")).toBe(true);
		});

		it("preserves text content when transforming to paragraph", () => {
			editor.commands.setHeading({ level: 2 });
			const transform = textBlockTypes.find((t) => t.id === "paragraph");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});
	});

	describe("Transform to Heading", () => {
		it("transforms paragraph to heading 1", () => {
			const transform = textBlockTypes.find((t) => t.id === "heading1");
			transform?.transform(editor);

			expect(editor.isActive("heading", { level: 1 })).toBe(true);
		});

		it("transforms paragraph to heading 2", () => {
			const transform = textBlockTypes.find((t) => t.id === "heading2");
			transform?.transform(editor);

			expect(editor.isActive("heading", { level: 2 })).toBe(true);
		});

		it("transforms paragraph to heading 3", () => {
			const transform = textBlockTypes.find((t) => t.id === "heading3");
			transform?.transform(editor);

			expect(editor.isActive("heading", { level: 3 })).toBe(true);
		});

		it("preserves text content when transforming to heading", () => {
			const transform = textBlockTypes.find((t) => t.id === "heading1");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});

		it("can change heading level", () => {
			const h1Transform = textBlockTypes.find((t) => t.id === "heading1");
			h1Transform?.transform(editor);
			expect(editor.isActive("heading", { level: 1 })).toBe(true);

			const h2Transform = textBlockTypes.find((t) => t.id === "heading2");
			h2Transform?.transform(editor);
			expect(editor.isActive("heading", { level: 2 })).toBe(true);
			expect(editor.isActive("heading", { level: 1 })).toBe(false);
		});
	});

	describe("Transform to Blockquote", () => {
		it("transforms paragraph to blockquote", () => {
			const transform = textBlockTypes.find((t) => t.id === "blockquote");
			transform?.transform(editor);

			expect(editor.isActive("blockquote")).toBe(true);
		});

		it("preserves text content when transforming to blockquote", () => {
			const transform = textBlockTypes.find((t) => t.id === "blockquote");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});

		it("keeps a blockquote when it is turned into one again", () => {
			const transform = textBlockTypes.find((t) => t.id === "blockquote");
			transform?.transform(editor);
			expect(editor.isActive("blockquote")).toBe(true);

			transform?.transform(editor);
			expect(editor.isActive("blockquote")).toBe(true);
			expect(editor.getText().trim()).toBe("Test content");
		});
	});

	describe("Transform to Code block", () => {
		it("transforms paragraph to code block", () => {
			const transform = textBlockTypes.find((t) => t.id === "codeBlock");
			transform?.transform(editor);

			expect(editor.isActive("codeBlock")).toBe(true);
		});

		it("preserves text content when transforming to code block", () => {
			const transform = textBlockTypes.find((t) => t.id === "codeBlock");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});

		it("keeps a code block when it is turned into one again", () => {
			const transform = textBlockTypes.find((t) => t.id === "codeBlock");
			transform?.transform(editor);
			expect(editor.isActive("codeBlock")).toBe(true);

			transform?.transform(editor);
			expect(editor.isActive("codeBlock")).toBe(true);
			expect(editor.getText().trim()).toBe("Test content");
		});
	});

	describe("Transform to Bulleted list", () => {
		it("transforms paragraph to bullet list", () => {
			const transform = textBlockTypes.find((t) => t.id === "bulletList");
			transform?.transform(editor);

			expect(editor.isActive("bulletList")).toBe(true);
		});

		it("preserves text content when transforming to bullet list", () => {
			const transform = textBlockTypes.find((t) => t.id === "bulletList");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});

		it("keeps a bullet list when it is turned into one again", () => {
			const transform = textBlockTypes.find((t) => t.id === "bulletList");
			transform?.transform(editor);
			expect(editor.isActive("bulletList")).toBe(true);

			transform?.transform(editor);
			expect(editor.isActive("bulletList")).toBe(true);
			expect(editor.getText().trim()).toBe("Test content");
		});
	});

	describe("Transform to Ordered List", () => {
		it("transforms paragraph to ordered list", () => {
			const transform = textBlockTypes.find((t) => t.id === "orderedList");
			transform?.transform(editor);

			expect(editor.isActive("orderedList")).toBe(true);
		});

		it("preserves text content when transforming to ordered list", () => {
			const transform = textBlockTypes.find((t) => t.id === "orderedList");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});

		it("can switch between bullet and ordered list", () => {
			const bulletTransform = textBlockTypes.find((t) => t.id === "bulletList");
			bulletTransform?.transform(editor);
			expect(editor.isActive("bulletList")).toBe(true);

			const orderedTransform = textBlockTypes.find((t) => t.id === "orderedList");
			orderedTransform?.transform(editor);
			expect(editor.isActive("orderedList")).toBe(true);
			expect(editor.isActive("bulletList")).toBe(false);
		});
	});

	describe("Transform metadata", () => {
		it("has all required transform definitions", () => {
			const expectedIds = [
				"paragraph",
				"heading1",
				"heading2",
				"heading3",
				"blockquote",
				"codeBlock",
				"bulletList",
				"orderedList",
			];

			for (const id of expectedIds) {
				const transform = textBlockTypes.find((t) => t.id === id);
				expect(transform, `Transform "${id}" should exist`).toBeDefined();
				expect(transform?.label, `Transform "${id}" should have a label`).toBeTruthy();
				expect(transform?.icon, `Transform "${id}" should have an icon`).toBeDefined();
				expect(
					typeof transform?.transform,
					`Transform "${id}" should have a transform function`,
				).toBe("function");
			}
		});
	});
});

describe("Turn into", () => {
	let editor: Editor;

	const NESTED_LIST =
		"<ul><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li><li><p>three</p></li></ul><p>end</p>";

	function create(content: string) {
		editor = new Editor({
			extensions: [StarterKit, TextAlign.configure({ types: ["heading", "paragraph"] })],
			content,
		});
	}

	function turnInto(id: string) {
		textBlockTypes.find((type) => type.id === id)!.transform(editor);
	}

	afterEach(() => {
		editor.destroy();
	});

	it("turns every item of a list selected whole into its own block", () => {
		create(NESTED_LIST);
		editor.commands.setNodeSelection(0);

		turnInto("paragraph");

		expect(editor.getHTML()).toBe("<p>one</p><p>two</p><p>nested</p><p>three</p><p>end</p>");
	});

	it("undoes a Turn into in one step", () => {
		create(NESTED_LIST);
		const before = editor.getJSON();
		editor.commands.setNodeSelection(0);

		turnInto("heading2");
		editor.commands.undo();

		expect(editor.getJSON()).toEqual(before);
	});

	it("switches a list's type without flattening its nesting", () => {
		create(NESTED_LIST);
		editor.commands.setNodeSelection(0);

		turnInto("orderedList");

		expect(editor.getHTML()).toBe(
			"<ol><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li><li><p>three</p></li></ol><p>end</p>",
		);
	});

	it("gives every paragraph of a quote its own list item", () => {
		create("<blockquote><p>first</p><p>second</p></blockquote><p>end</p>");
		editor.commands.setNodeSelection(0);

		turnInto("bulletList");

		expect(editor.getHTML()).toBe("<ul><li><p>first</p></li><li><p>second</p></li></ul><p>end</p>");
	});

	it("leaves a list alone when it is turned into its own type", () => {
		create("<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul><p>end</p>");
		const before = editor.getJSON();
		editor.commands.setNodeSelection(0);

		turnInto("bulletList");

		expect(editor.getJSON()).toEqual(before);
	});

	it("takes only the selected items out of a list, splitting it around them", () => {
		create("<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul><p>end</p>");
		editor.commands.setTextSelection({ from: 11, to: 12 });

		turnInto("paragraph");

		expect(editor.getHTML()).toBe(
			"<ul><li><p>one</p></li></ul><p>two</p><ul><li><p>three</p></li></ul><p>end</p>",
		);
	});

	it("keeps a block's alignment", () => {
		create('<p style="text-align: center">centered</p><p>end</p>');
		editor.commands.setNodeSelection(0);

		turnInto("heading2");

		expect(editor.getHTML()).toBe('<h2 style="text-align: center;">centered</h2><p>end</p>');
	});

	it.each([
		["a heading", "<h2>words</h2><p>end</p>"],
		["a code block", "<pre><code>words</code></pre><p>end</p>"],
	])("turns %s into quoted text", (_, content) => {
		create(content);
		editor.commands.setTextSelection(2);

		turnInto("blockquote");

		expect(editor.getHTML()).toBe("<blockquote><p>words</p></blockquote><p>end</p>");
	});

	it("drops an alignment that a quote or list item can't keep", () => {
		create('<p style="text-align: center">centered</p><p>end</p>');
		editor.commands.setTextSelection(2);

		turnInto("bulletList");

		expect(editor.getHTML()).toBe("<ul><li><p>centered</p></li></ul><p>end</p>");
	});

	it("joins a new list with lists of the same type around it", () => {
		create("<ol><li><p>one</p></li></ol><p>two</p><ol><li><p>three</p></li></ol><p>end</p>");
		editor.commands.setTextSelection(12);

		turnInto("orderedList");

		expect(editor.getHTML()).toBe(
			"<ol><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ol><p>end</p>",
		);
	});

	it("keeps a following numbered list's own start number", () => {
		create('<p>one</p><ol start="5"><li><p>five</p></li></ol><p>end</p>');
		editor.commands.setTextSelection(2);

		turnInto("orderedList");

		expect(editor.getHTML()).toBe(
			'<ol><li><p>one</p></li></ol><ol start="5"><li><p>five</p></li></ol><p>end</p>',
		);
	});

	it("switches a nested list that differs from its parent list on its own", () => {
		const nested =
			"<ol><li><p>a</p><ul><li><p>n1</p></li><li><p>n2</p></li></ul></li></ol><p>end</p>";
		create(nested);
		editor.commands.setTextSelection(9);

		expect(activeTextBlockType(editor)?.id).toBe("bulletList");
		turnInto("orderedList");

		expect(editor.getHTML()).toBe(
			"<ol><li><p>a</p><ol><li><p>n1</p></li><li><p>n2</p></li></ol></li></ol><p>end</p>",
		);
	});

	it("moves a nested list item up one level when its list type is toggled off", () => {
		create("<ul><li><p>a</p><ul><li><p>n1</p></li></ul></li></ul><p>end</p>");
		editor.commands.setTextSelection(9);

		toggleTextBlockType(editor, "bulletList");

		expect(editor.getHTML()).toBe("<ul><li><p>a</p></li><li><p>n1</p></li></ul><p>end</p>");
	});

	it("turns a list selected whole back into text when its list type is toggled off", () => {
		create("<ul><li><p>one</p></li><li><p>two</p></li></ul><p>end</p>");
		editor.commands.setNodeSelection(0);

		toggleTextBlockType(editor, "bulletList");

		expect(editor.getHTML()).toBe("<p>one</p><p>two</p><p>end</p>");
	});

	it("offers to convert a selection that mixes block types", () => {
		create("<p>one</p><h2>two</h2><p>end</p>");
		editor.commands.setTextSelection({ from: 2, to: 8 });

		expect(canTurnInto(editor)).toBe(true);
		turnInto("bulletList");

		expect(editor.getHTML()).toBe("<ul><li><p>one</p></li><li><p>two</p></li></ul><p>end</p>");
	});

	it("doesn't offer to convert a selection holding a divider", () => {
		create("<p>one</p><hr><p>two</p>");
		editor.commands.setTextSelection({ from: 2, to: 8 });

		expect(canTurnInto(editor)).toBe(false);
	});
});

describe("Block Duplicate", () => {
	let editor: Editor;

	beforeEach(() => {
		editor = new Editor({
			extensions: [
				StarterKit.configure({
					heading: { levels: [1, 2, 3] },
				}),
			],
			content: "<p>First paragraph</p><p>Second paragraph</p>",
		});
	});

	afterEach(() => {
		editor.destroy();
	});

	it("duplicates block and preserves content", () => {
		// Position cursor in first paragraph
		editor.commands.setTextSelection(1);

		const { selection } = editor.state;
		const { $from, $to } = selection;

		// Get the block node at current position
		const blockStart = $from.start($from.depth);
		const blockEnd = $to.end($to.depth);

		// Get the content to duplicate
		const slice = editor.state.doc.slice(blockStart, blockEnd);

		// Insert after current block
		editor
			.chain()
			.focus()
			.command(({ tr }) => {
				tr.insert(blockEnd + 1, slice.content);
				return true;
			})
			.run();

		const json = editor.getJSON();
		expect(json.content?.length).toBe(3); // Now 3 paragraphs

		// Check content
		const texts =
			json.content?.map((block) => {
				if (block.type === "paragraph" && block.content?.[0]) {
					return (block.content[0] as { text?: string }).text;
				}
				return "";
			}) ?? [];

		expect(texts[0]).toBe("First paragraph");
		expect(texts[1]).toBe("First paragraph"); // Duplicated
		expect(texts[2]).toBe("Second paragraph");
	});
});

describe("Block Delete", () => {
	let editor: Editor;

	beforeEach(() => {
		editor = new Editor({
			extensions: [
				StarterKit.configure({
					heading: { levels: [1, 2, 3] },
				}),
			],
			content: "<p>First paragraph</p><p>Second paragraph</p>",
		});
	});

	afterEach(() => {
		editor.destroy();
	});

	it("deletes block at cursor position", () => {
		// Position cursor in first paragraph
		editor.commands.setTextSelection(1);

		editor.commands.deleteNode("paragraph");

		const json = editor.getJSON();
		expect(json.content?.length).toBe(1); // Now 1 paragraph

		// Check remaining content
		const text =
			json.content?.[0]?.type === "paragraph" && json.content[0].content?.[0]
				? (json.content[0].content[0] as { text?: string }).text
				: "";

		expect(text).toBe("Second paragraph");
	});
});
