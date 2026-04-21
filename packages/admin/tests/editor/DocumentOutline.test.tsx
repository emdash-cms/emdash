import { describe, it, expect } from "vitest";

import {
	extractHeadings,
	findCurrentHeading,
	type HeadingItem,
} from "../../src/components/editor/DocumentOutline";

/**
 * Create a mock editor with a document containing the specified headings
 */
function createMockEditor(headings: Array<{ level: number; text: string; pos: number }>) {
	const mockDoc = {
		descendants: (
			callback: (
				node: { type: { name: string }; attrs: { level: number }; textContent: string },
				pos: number,
			) => void,
		) => {
			for (const heading of headings) {
				callback(
					{
						type: { name: "heading" },
						attrs: { level: heading.level },
						textContent: heading.text,
					},
					heading.pos,
				);
			}
		},
	};

	return {
		state: {
			doc: mockDoc,
		},
	} as unknown as Parameters<typeof extractHeadings>[0];
}

describe("DocumentOutline", () => {
	describe("extractHeadings", () => {
		it("returns empty array when editor is null", () => {
			const result = extractHeadings(null);
			expect(result).toEqual([]);
		});

		it("extracts headings from editor document", () => {
			const editor = createMockEditor([
				{ level: 1, text: "Main Title", pos: 0 },
				{ level: 2, text: "Section One", pos: 50 },
				{ level: 3, text: "Subsection", pos: 100 },
			]);

			const result = extractHeadings(editor);

			expect(result).toHaveLength(3);
			expect(result[0]).toMatchObject({
				level: 1,
				text: "Main Title",
				pos: 0,
			});
			expect(result[1]).toMatchObject({
				level: 2,
				text: "Section One",
				pos: 50,
			});
			expect(result[2]).toMatchObject({
				level: 3,
				text: "Subsection",
				pos: 100,
			});
		});

		it("skips headings with empty text", () => {
			const editor = createMockEditor([
				{ level: 1, text: "Title", pos: 0 },
				{ level: 2, text: "", pos: 50 },
				{ level: 2, text: "   ", pos: 100 },
				{ level: 2, text: "Valid", pos: 150 },
			]);

			const result = extractHeadings(editor);

			expect(result).toHaveLength(2);
			expect(result[0]?.text).toBe("Title");
			expect(result[1]?.text).toBe("Valid");
		});

		it("assigns unique keys to headings", () => {
			const editor = createMockEditor([
				{ level: 1, text: "Title", pos: 0 },
				{ level: 2, text: "Section", pos: 50 },
			]);

			const result = extractHeadings(editor);

			expect(result[0]?.key).toBeDefined();
			expect(result[1]?.key).toBeDefined();
			expect(result[0]?.key).not.toBe(result[1]?.key);
		});
	});

	describe("findCurrentHeading", () => {
		const headings: HeadingItem[] = [
			{ level: 1, text: "Title", pos: 0, key: "h1" },
			{ level: 2, text: "Section One", pos: 100, key: "h2" },
			{ level: 2, text: "Section Two", pos: 200, key: "h3" },
			{ level: 3, text: "Subsection", pos: 300, key: "h4" },
		];

		it("returns null for empty headings array", () => {
			const result = findCurrentHeading([], 50);
			expect(result).toBeNull();
		});

		it("returns null when cursor is before first heading", () => {
			const headingsWithOffset: HeadingItem[] = [{ level: 1, text: "Title", pos: 100, key: "h1" }];
			const result = findCurrentHeading(headingsWithOffset, 50);
			expect(result).toBeNull();
		});

		it("returns first heading when cursor is at its position", () => {
			const result = findCurrentHeading(headings, 0);
			expect(result?.key).toBe("h1");
		});

		it("returns heading that contains cursor position", () => {
			const result = findCurrentHeading(headings, 150);
			expect(result?.key).toBe("h2");
		});

		it("returns last heading when cursor is past all headings", () => {
			const result = findCurrentHeading(headings, 500);
			expect(result?.key).toBe("h4");
		});

		it("returns heading when cursor is exactly at heading position", () => {
			const result = findCurrentHeading(headings, 200);
			expect(result?.key).toBe("h3");
		});
	});

	describe("indentation", () => {
		it("correctly structures heading levels", () => {
			const editor = createMockEditor([
				{ level: 1, text: "H1", pos: 0 },
				{ level: 2, text: "H2", pos: 50 },
				{ level: 3, text: "H3", pos: 100 },
			]);

			const result = extractHeadings(editor);

			// H1 should be at root level
			expect(result[0]?.level).toBe(1);
			// H2 should be indented (level 2)
			expect(result[1]?.level).toBe(2);
			// H3 should be further indented (level 3)
			expect(result[2]?.level).toBe(3);
		});
	});
});
