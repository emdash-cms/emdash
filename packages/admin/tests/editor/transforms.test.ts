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
 * These transformations are used by the BlockMenu component.
 */

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { blockTransforms } from "../../src/components/editor/BlockMenu";

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

			const transform = blockTransforms.find((t) => t.id === "paragraph");
			transform?.transform(editor);

			expect(editor.isActive("heading")).toBe(false);
			expect(editor.isActive("paragraph")).toBe(true);
		});

		it("preserves text content when transforming to paragraph", () => {
			editor.commands.setHeading({ level: 2 });
			const transform = blockTransforms.find((t) => t.id === "paragraph");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});
	});

	describe("Transform to Heading", () => {
		it("transforms paragraph to heading 1", () => {
			const transform = blockTransforms.find((t) => t.id === "heading1");
			transform?.transform(editor);

			expect(editor.isActive("heading", { level: 1 })).toBe(true);
		});

		it("transforms paragraph to heading 2", () => {
			const transform = blockTransforms.find((t) => t.id === "heading2");
			transform?.transform(editor);

			expect(editor.isActive("heading", { level: 2 })).toBe(true);
		});

		it("transforms paragraph to heading 3", () => {
			const transform = blockTransforms.find((t) => t.id === "heading3");
			transform?.transform(editor);

			expect(editor.isActive("heading", { level: 3 })).toBe(true);
		});

		it("preserves text content when transforming to heading", () => {
			const transform = blockTransforms.find((t) => t.id === "heading1");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});

		it("can change heading level", () => {
			const h1Transform = blockTransforms.find((t) => t.id === "heading1");
			h1Transform?.transform(editor);
			expect(editor.isActive("heading", { level: 1 })).toBe(true);

			const h2Transform = blockTransforms.find((t) => t.id === "heading2");
			h2Transform?.transform(editor);
			expect(editor.isActive("heading", { level: 2 })).toBe(true);
			expect(editor.isActive("heading", { level: 1 })).toBe(false);
		});
	});

	describe("Transform to Blockquote", () => {
		it("transforms paragraph to blockquote", () => {
			const transform = blockTransforms.find((t) => t.id === "blockquote");
			transform?.transform(editor);

			expect(editor.isActive("blockquote")).toBe(true);
		});

		it("preserves text content when transforming to blockquote", () => {
			const transform = blockTransforms.find((t) => t.id === "blockquote");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});

		it("toggles blockquote off when already active", () => {
			const transform = blockTransforms.find((t) => t.id === "blockquote");
			transform?.transform(editor);
			expect(editor.isActive("blockquote")).toBe(true);

			transform?.transform(editor);
			expect(editor.isActive("blockquote")).toBe(false);
		});
	});

	describe("Transform to Code Block", () => {
		it("transforms paragraph to code block", () => {
			const transform = blockTransforms.find((t) => t.id === "codeBlock");
			transform?.transform(editor);

			expect(editor.isActive("codeBlock")).toBe(true);
		});

		it("preserves text content when transforming to code block", () => {
			const transform = blockTransforms.find((t) => t.id === "codeBlock");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});

		it("toggles code block off when already active", () => {
			const transform = blockTransforms.find((t) => t.id === "codeBlock");
			transform?.transform(editor);
			expect(editor.isActive("codeBlock")).toBe(true);

			transform?.transform(editor);
			expect(editor.isActive("codeBlock")).toBe(false);
		});
	});

	describe("Transform to Bullet List", () => {
		it("transforms paragraph to bullet list", () => {
			const transform = blockTransforms.find((t) => t.id === "bulletList");
			transform?.transform(editor);

			expect(editor.isActive("bulletList")).toBe(true);
		});

		it("preserves text content when transforming to bullet list", () => {
			const transform = blockTransforms.find((t) => t.id === "bulletList");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});

		it("toggles bullet list off when already active", () => {
			const transform = blockTransforms.find((t) => t.id === "bulletList");
			transform?.transform(editor);
			expect(editor.isActive("bulletList")).toBe(true);

			transform?.transform(editor);
			expect(editor.isActive("bulletList")).toBe(false);
		});
	});

	describe("Transform to Ordered List", () => {
		it("transforms paragraph to ordered list", () => {
			const transform = blockTransforms.find((t) => t.id === "orderedList");
			transform?.transform(editor);

			expect(editor.isActive("orderedList")).toBe(true);
		});

		it("preserves text content when transforming to ordered list", () => {
			const transform = blockTransforms.find((t) => t.id === "orderedList");
			transform?.transform(editor);

			expect(editor.getText().trim()).toBe("Test content");
		});

		it("can switch between bullet and ordered list", () => {
			const bulletTransform = blockTransforms.find((t) => t.id === "bulletList");
			bulletTransform?.transform(editor);
			expect(editor.isActive("bulletList")).toBe(true);

			const orderedTransform = blockTransforms.find((t) => t.id === "orderedList");
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
				const transform = blockTransforms.find((t) => t.id === id);
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
