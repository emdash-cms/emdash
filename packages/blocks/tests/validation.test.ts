import { describe, expect, it } from "vitest";

import { validateBlocks } from "../src/validation.js";

describe("validateBlocks", () => {
	// ── Valid blocks ─────────────────────────────────────────────────────────

	describe("valid blocks", () => {
		it("header", () => {
			const result = validateBlocks([{ type: "header", text: "Hello" }]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("section", () => {
			const result = validateBlocks([{ type: "section", text: "Body text" }]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("divider", () => {
			const result = validateBlocks([{ type: "divider" }]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("fields", () => {
			const result = validateBlocks([
				{
					type: "fields",
					fields: [{ label: "Status", value: "Active" }],
				},
			]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("table", () => {
			const result = validateBlocks([
				{
					type: "table",
					columns: [{ key: "name", label: "Name" }],
					rows: [{ name: "Alice" }],
					page_action_id: "load_page",
				},
			]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("actions", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [{ type: "button", action_id: "btn1", label: "Click me" }],
				},
			]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("stats", () => {
			const result = validateBlocks([
				{
					type: "stats",
					items: [{ label: "Users", value: 42 }],
				},
			]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("form", () => {
			const result = validateBlocks([
				{
					type: "form",
					fields: [{ type: "text_input", action_id: "name", label: "Name" }],
					submit: { label: "Save", action_id: "save" },
				},
			]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("image", () => {
			const result = validateBlocks([
				{ type: "image", url: "https://example.com/img.png", alt: "Photo" },
			]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("context", () => {
			const result = validateBlocks([{ type: "context", text: "Last updated 5m ago" }]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("columns", () => {
			const result = validateBlocks([
				{
					type: "columns",
					columns: [[{ type: "header", text: "Left" }], [{ type: "header", text: "Right" }]],
				},
			]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("empty (minimal)", () => {
			const result = validateBlocks([{ type: "empty", title: "No items" }]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("empty (full)", () => {
			const result = validateBlocks([
				{
					type: "empty",
					title: "No webhooks yet",
					description: "Create your first webhook to receive notifications.",
					command_line: "emdash webhooks create",
					size: "lg",
					actions: [
						{ type: "button", action_id: "create", label: "Create webhook", style: "primary" },
						{ type: "button", action_id: "import", label: "Import" },
					],
				},
			]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("repeater", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [
						{
							type: "repeater",
							action_id: "faqs",
							label: "FAQs",
							item_label: "FAQ",
							min_items: 1,
							max_items: 5,
							fields: [
								{ type: "text_input", action_id: "question", label: "Question" },
								{ type: "text_input", action_id: "answer", label: "Answer", multiline: true },
							],
							initial_value: [{ question: "Q1", answer: "A1" }],
						},
					],
				},
			]);
			expect(result).toEqual({ valid: true, errors: [] });
		});
	});

	// ── Invalid blocks ───────────────────────────────────────────────────────

	describe("invalid blocks", () => {
		it("not an array", () => {
			const result = validateBlocks("not an array");
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual([{ path: "blocks", message: "Blocks must be an array" }]);
		});

		it("block without type", () => {
			const result = validateBlocks([{ text: "hello" }]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].type");
			expect(result.errors[0]!.message).toContain("Unknown block type");
		});

		it("block with unknown type", () => {
			const result = validateBlocks([{ type: "foobar" }]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].type");
			expect(result.errors[0]!.message).toContain("Unknown block type 'foobar'");
		});

		it("header missing text", () => {
			const result = validateBlocks([{ type: "header" }]);
			expect(result.valid).toBe(false);
			expect(result.errors).toEqual([
				{
					path: "blocks[0].text",
					message: "Required field 'text' must be a string",
				},
			]);
		});

		it("section missing text", () => {
			const result = validateBlocks([{ type: "section" }]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].text");
		});

		it("table missing required fields", () => {
			const result = validateBlocks([{ type: "table" }]);
			expect(result.valid).toBe(false);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].columns");
			expect(paths).toContain("blocks[0].rows");
			expect(paths).toContain("blocks[0].page_action_id");
		});

		it("table column missing key or label", () => {
			const result = validateBlocks([
				{
					type: "table",
					columns: [{ format: "text" }],
					rows: [],
					page_action_id: "p",
				},
			]);
			expect(result.valid).toBe(false);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].columns[0].key");
			expect(paths).toContain("blocks[0].columns[0].label");
		});

		it("table column with invalid format", () => {
			const result = validateBlocks([
				{
					type: "table",
					columns: [{ key: "k", label: "K", format: "html" }],
					rows: [],
					page_action_id: "p",
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].columns[0].format");
			expect(result.errors[0]!.message).toContain("format");
		});

		it("form missing fields or submit", () => {
			const result = validateBlocks([{ type: "form" }]);
			expect(result.valid).toBe(false);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].fields");
			expect(paths).toContain("blocks[0].submit");
		});

		it("form submit missing action_id", () => {
			const result = validateBlocks([
				{
					type: "form",
					fields: [],
					submit: { label: "Save" },
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].submit.action_id");
		});

		it("actions with invalid elements", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [{ type: "invalid_type" }],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].elements[0].type");
			expect(result.errors[0]!.message).toContain("Unknown element type");
		});

		it("select with empty options array", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [
						{
							type: "select",
							action_id: "sel",
							label: "Pick",
							options: [],
						},
					],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].elements[0].options");
			expect(result.errors[0]!.message).toContain("must not be empty");
		});

		it("select option missing label/value", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [
						{
							type: "select",
							action_id: "sel",
							label: "Pick",
							options: [{ foo: "bar" }],
						},
					],
				},
			]);
			expect(result.valid).toBe(false);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].elements[0].options[0].label");
			expect(paths).toContain("blocks[0].elements[0].options[0].value");
		});

		it("button with invalid style", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "btn",
							label: "Go",
							style: "bold",
						},
					],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].elements[0].style");
		});

		it("confirm dialog missing required fields", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "btn",
							label: "Delete",
							confirm: {},
						},
					],
				},
			]);
			expect(result.valid).toBe(false);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].elements[0].confirm.title");
			expect(paths).toContain("blocks[0].elements[0].confirm.text");
			expect(paths).toContain("blocks[0].elements[0].confirm.confirm");
			expect(paths).toContain("blocks[0].elements[0].confirm.deny");
		});

		it("image missing url or alt", () => {
			const result = validateBlocks([{ type: "image" }]);
			expect(result.valid).toBe(false);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].url");
			expect(paths).toContain("blocks[0].alt");
		});

		it("columns with less than 2 arrays", () => {
			const result = validateBlocks([
				{
					type: "columns",
					columns: [[{ type: "divider" }]],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].columns");
			expect(result.errors[0]!.message).toContain("2-3 column arrays");
		});

		it("columns with more than 3 arrays", () => {
			const result = validateBlocks([
				{
					type: "columns",
					columns: [
						[{ type: "divider" }],
						[{ type: "divider" }],
						[{ type: "divider" }],
						[{ type: "divider" }],
					],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.message).toContain("2-3 column arrays");
		});

		it("columns with invalid nested blocks reports correct path", () => {
			const result = validateBlocks([
				{
					type: "columns",
					columns: [
						[{ type: "header", text: "OK" }],
						[{ type: "header" }], // missing text
					],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].columns[1][0].text");
		});

		it("empty missing title", () => {
			const result = validateBlocks([{ type: "empty" }]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].title");
		});

		it("empty with invalid size", () => {
			const result = validateBlocks([{ type: "empty", title: "X", size: "huge" }]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].size");
		});

		it("empty with non-array actions", () => {
			const result = validateBlocks([{ type: "empty", title: "X", actions: "nope" }]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].actions");
		});

		it("empty with invalid action element reports correct path", () => {
			const result = validateBlocks([
				{
					type: "empty",
					title: "X",
					actions: [{ type: "button", action_id: "go", label: "Go", style: "neon" }],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].actions[0].style");
		});

		it("stats item missing label or value", () => {
			const result = validateBlocks([
				{
					type: "stats",
					items: [{ description: "desc" }],
				},
			]);
			expect(result.valid).toBe(false);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].items[0].label");
			expect(paths).toContain("blocks[0].items[0].value");
		});

		it("stats item with invalid trend", () => {
			const result = validateBlocks([
				{
					type: "stats",
					items: [{ label: "Users", value: 10, trend: "sideways" }],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].items[0].trend");
		});

		it("repeater with empty fields array", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [{ type: "repeater", action_id: "items", label: "Items", fields: [] }],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].elements[0].fields");
			expect(result.errors[0]!.message).toContain("must not be empty");
		});

		it("repeater with disallowed sub-field type", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [
						{
							type: "repeater",
							action_id: "items",
							label: "Items",
							fields: [
								{
									type: "checkbox",
									action_id: "opts",
									label: "Opts",
									options: [{ label: "A", value: "a" }],
								},
							],
						},
					],
				},
			]);
			expect(result.valid).toBe(false);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].elements[0].fields[0].type");
			expect(
				result.errors.find((e) => e.path === "blocks[0].elements[0].fields[0].type")!.message,
			).toContain("not allowed");
		});

		it("repeater with non-integer min_items / max_items", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [
						{
							type: "repeater",
							action_id: "items",
							label: "Items",
							fields: [{ type: "text_input", action_id: "q", label: "Q" }],
							min_items: 1.5,
							max_items: -2,
						},
					],
				},
			]);
			expect(result.valid).toBe(false);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].elements[0].min_items");
			expect(paths).toContain("blocks[0].elements[0].max_items");
		});

		it("repeater with min_items greater than max_items", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [
						{
							type: "repeater",
							action_id: "items",
							label: "Items",
							fields: [{ type: "text_input", action_id: "q", label: "Q" }],
							min_items: 5,
							max_items: 2,
						},
					],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].elements[0].min_items");
			expect(result.errors[0]!.message).toContain("less than or equal to 'max_items'");
		});

		it("repeater initial_value not an array", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [
						{
							type: "repeater",
							action_id: "items",
							label: "Items",
							fields: [{ type: "text_input", action_id: "q", label: "Q" }],
							initial_value: "not-an-array",
						},
					],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].elements[0].initial_value");
			expect(result.errors[0]!.message).toContain("must be an array");
		});

		it("repeater initial_value entry not an object", () => {
			const result = validateBlocks([
				{
					type: "actions",
					elements: [
						{
							type: "repeater",
							action_id: "items",
							label: "Items",
							fields: [{ type: "text_input", action_id: "q", label: "Q" }],
							initial_value: [{ q: "ok" }, "bad", null],
						},
					],
				},
			]);
			expect(result.valid).toBe(false);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].elements[0].initial_value[1]");
			expect(paths).toContain("blocks[0].elements[0].initial_value[2]");
		});

		it("form field with invalid condition (no eq/neq)", () => {
			const result = validateBlocks([
				{
					type: "form",
					fields: [
						{
							type: "text_input",
							action_id: "name",
							label: "Name",
							condition: { field: "toggle" },
						},
					],
					submit: { label: "Save", action_id: "save" },
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].fields[0].condition");
			expect(result.errors[0]!.message).toContain("either 'eq' or 'neq'");
		});
	});

	// ── Edge cases ───────────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("empty blocks array is valid", () => {
			const result = validateBlocks([]);
			expect(result).toEqual({ valid: true, errors: [] });
		});

		it("deeply nested columns validate recursively", () => {
			const result = validateBlocks([
				{
					type: "columns",
					columns: [
						[
							{
								type: "columns",
								columns: [
									[{ type: "header", text: "Deep left" }],
									[{ type: "header" }], // missing text
								],
							},
						],
						[{ type: "divider" }],
					],
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.errors[0]!.path).toBe("blocks[0].columns[0][0].columns[1][0].text");
		});

		it("multiple errors in one block are all reported", () => {
			const result = validateBlocks([
				{
					type: "table",
					columns: [{ format: "invalid" }], // missing key, label, bad format
					rows: "not an array",
					// missing page_action_id
				},
			]);
			expect(result.valid).toBe(false);
			// Should have errors for key, label, format, rows, and page_action_id
			expect(result.errors.length).toBeGreaterThanOrEqual(4);
			const paths = result.errors.map((e) => e.path);
			expect(paths).toContain("blocks[0].columns[0].key");
			expect(paths).toContain("blocks[0].columns[0].label");
			expect(paths).toContain("blocks[0].columns[0].format");
			expect(paths).toContain("blocks[0].rows");
			expect(paths).toContain("blocks[0].page_action_id");
		});
	});
});
