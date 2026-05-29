import { describe, expect, it } from "vitest";

import { validateBuilderDocument, newBuilderDocument, newBlockId } from "../src/builder/schema.js";
import { renderBlockDocument } from "../src/builder/renderer.js";
import { exportToBuilderSchema } from "../src/builder/lexical-to-builder.js";
import {
	importFromBuilderSchema,
	importPortableTextToLexicalState,
} from "../src/builder/builder-to-lexical.js";

// ── schema ─────────────────────────────────────────────────────────────────────

describe("validateBuilderDocument", () => {
	it("empty document is valid", () => {
		const result = validateBuilderDocument(newBuilderDocument());
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("valid section block", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "s1",
					type: "section",
					props: { background: "#fff" },
					children: [{ id: "p1", type: "richText", content: [] }],
				},
			],
		};
		const result = validateBuilderDocument(doc);
		expect(result.valid).toBe(true);
	});

	it("valid columns block with two columns", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "c1",
					type: "columns",
					props: { gap: "1rem" },
					columns: [
						{ id: "col1", width: 6, blocks: [{ id: "b1", type: "divider" }] },
						{ id: "col2", width: 6, blocks: [{ id: "b2", type: "spacer", props: { height: "1rem" } }] },
					],
				},
			],
		};
		const result = validateBuilderDocument(doc);
		expect(result.valid).toBe(true);
	});

	it("invalid: wrong version", () => {
		const result = validateBuilderDocument({ version: 2, blocks: [] });
		expect(result.valid).toBe(false);
		expect(result.errors[0]!.path).toBe("version");
	});

	it("invalid: blocks is not an array", () => {
		const result = validateBuilderDocument({ version: 1, blocks: "not-array" });
		expect(result.valid).toBe(false);
		expect(result.errors[0]!.path).toBe("blocks");
	});

	it("invalid: unknown block type", () => {
		const result = validateBuilderDocument({ version: 1, blocks: [{ id: "x", type: "unknown" }] });
		expect(result.valid).toBe(false);
		expect(result.errors[0]!.path).toBe("blocks[0].type");
	});

	it("invalid: section.children must be array", () => {
		const result = validateBuilderDocument({
			version: 1,
			blocks: [{ id: "s1", type: "section", children: "not-array" }],
		});
		expect(result.valid).toBe(false);
		expect(result.errors[0]!.path).toBe("blocks[0].children");
	});

	it("invalid: columns.columns must be array", () => {
		const result = validateBuilderDocument({
			version: 1,
			blocks: [{ id: "c1", type: "columns", columns: "not-array" }],
		});
		expect(result.valid).toBe(false);
		expect(result.errors[0]!.path).toBe("blocks[0].columns");
	});

	it("invalid: column.blocks must be array", () => {
		const result = validateBuilderDocument({
			version: 1,
			blocks: [
				{
					id: "c1",
					type: "columns",
					columns: [{ id: "col1", blocks: "not-array" }],
				},
			],
		});
		expect(result.valid).toBe(false);
		expect(result.errors[0]!.path).toBe("blocks[0].columns[0].blocks");
	});

	it("valid: legacy Lexical JSON is treated as valid (backward compat)", () => {
		// Old revisions stored raw Lexical JSON (has root.children, no version/blocks)
		const legacyLexical = {
			root: {
				children: [{ type: "paragraph", children: [{ type: "text", text: "Hello" }] }],
				direction: "ltr",
				format: "",
				indent: 0,
				type: "root",
				version: 1,
			},
		};
		const result = validateBuilderDocument(legacyLexical as any);
		expect(result.valid).toBe(true);
	});
});

// ── renderer ───────────────────────────────────────────────────────────────────

describe("renderBlockDocument", () => {
	it("empty document returns empty string", () => {
		expect(renderBlockDocument(newBuilderDocument())).toBe("");
	});

	it("section with background and padding", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "s1",
					type: "section",
					props: { background: "#f0f0f0", padding: "2rem", maxWidth: "800px" },
					children: [],
				},
			],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain("background-color: #f0f0f0");
		expect(html).toContain("padding: 2rem");
		expect(html).toContain("max-width: 800px");
	});

	it("richText renders paragraph with escaped HTML", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "p1",
					type: "richText",
					content: [
						{
							_type: "paragraph",
							children: [{ text: "Hello <world>", bold: true }],
						},
					],
				},
			],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain("<strong>Hello &lt;world&gt;</strong>");
		expect(html).toContain("<p>");
	});

	it("richText heading renders h2 by default", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "h1",
					type: "richText",
					content: [{ _type: "heading", children: [{ text: "Title" }] }],
				},
			],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain("<h2>Title</h2>");
	});

	it("image renders img with escaped src/alt", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "i1",
					type: "image",
					props: { src: "https://example.com/photo.png", alt: "A photo" },
				},
			],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain('src="https://example.com/photo.png"');
		expect(html).toContain('alt="A photo"');
	});

	it("button renders anchor with classes", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "b1",
					type: "button",
					props: { text: "Click me", href: "/page", variant: "primary", size: "large" },
				},
			],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain('href="/page"');
		expect(html).toContain("btn-primary");
		expect(html).toContain("btn-large");
	});

	it("spacer renders div with height", () => {
		const doc = {
			version: 1,
			blocks: [{ id: "sp1", type: "spacer", props: { height: "3rem" } }],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain("height: 3rem");
	});

	it("divider renders hr", () => {
		const doc = {
			version: 1,
			blocks: [{ id: "d1", type: "divider" }],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain("<hr");
	});

	it("columns renders CSS grid", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "c1",
					type: "columns",
					props: { gap: "2rem" },
					columns: [
						{ id: "col1", width: 6, blocks: [{ id: "b1", type: "divider" }] },
						{ id: "col2", width: 6, blocks: [{ id: "b2", type: "divider" }] },
					],
				},
			],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain("display: grid");
		expect(html).toContain("grid-template-columns: repeat(2, 1fr)");
		expect(html).toContain("gap: 2rem");
	});

	it("container renders div with styles", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "co1",
					type: "container",
					props: { background: "#000", padding: "1rem", maxWidth: "600px" },
				},
			],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain("background-color: #000");
		expect(html).toContain("padding: 1rem");
	});

	it("unknown block type renders comment", () => {
		const doc = {
			version: 1,
			blocks: [{ id: "x1", type: "unknown" } as any],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain("unknown block type");
	});

	it("renderBlockDocument handles section-wrapped content", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "s1",
					type: "section",
					props: { background: "#fff", padding: "1rem", maxWidth: "1200px" },
					children: [
						{
							id: "c1",
							type: "columns",
							props: { gap: "1rem" },
							columns: [
								{ id: "col1", width: 12, blocks: [{ id: "b1", type: "divider" }] },
							],
						},
					],
				},
			],
		};
		const html = renderBlockDocument(doc);
		expect(html).toContain("<section");
		expect(html).toContain("background-color: #fff");
		expect(html).toContain("grid-template-columns");
	});
});

// ── lexical-to-builder (export) ───────────────────────────────────────────────

describe("exportToBuilderSchema", () => {
	it("empty lexical JSON returns empty document", () => {
		const result = exportToBuilderSchema(null);
		expect(result.blocks).toHaveLength(0);
	});

	it("paragraph converts to richText", () => {
		const lexicalJson = {
			root: {
				children: [
					{
						type: "paragraph",
						children: [{ type: "text", text: "Hello" }],
					},
				],
			},
		};
		const doc = exportToBuilderSchema(lexicalJson);
		expect(doc.blocks[0]!.type).toBe("section");
		const section = doc.blocks[0] as any;
		expect(section.children[0]!.type).toBe("columns");
		const columns = section.children[0] as any;
		const richText = columns.columns[0]!.blocks[0] as any;
		expect(richText.type).toBe("richText");
		expect(richText.content[0]._type).toBe("paragraph");
		expect(richText.content[0].children[0].text).toBe("Hello");
	});

	it("exported paragraph renders text through BuilderDocument", () => {
		const lexicalJson = {
			root: {
				children: [
					{
						type: "paragraph",
						children: [{ type: "text", text: "Hello", format: 1 }],
					},
				],
			},
		};
		const html = renderBlockDocument(exportToBuilderSchema(lexicalJson));
		expect(html).toContain("<strong>Hello</strong>");
	});

	it("button converts to button block", () => {
		const lexicalJson = {
			root: {
				children: [
					{
						type: "button",
						text: "Click me",
						variant: "secondary",
						size: "large",
					},
				],
			},
		};
		const doc = exportToBuilderSchema(lexicalJson);
		const section = doc.blocks[0] as any;
		const columns = section.children[0] as any;
		const btn = columns.columns[0].blocks[0] as any;
		expect(btn.type).toBe("button");
		expect(btn.props.text).toBe("Click me");
		expect(btn.props.variant).toBe("secondary");
		expect(btn.props.size).toBe("large");
	});

	it("image converts to image block", () => {
		const lexicalJson = {
			root: {
				children: [
					{
						type: "image",
						src: "https://example.com/photo.jpg",
						alt: "A photo",
						width: "50%",
						alignment: "left",
					},
				],
			},
		};
		const doc = exportToBuilderSchema(lexicalJson);
		const section = doc.blocks[0] as any;
		const columns = section.children[0] as any;
		const img = columns.columns[0].blocks[0] as any;
		expect(img.type).toBe("image");
		expect(img.props.src).toBe("https://example.com/photo.jpg");
		expect(img.props.alt).toBe("A photo");
		expect(img.props.width).toBe("50%");
		expect(img.props.alignment).toBe("left");
	});

	it("wraps flat content in default section + columns", () => {
		const lexicalJson = {
			root: {
				children: [{ type: "spacer", height: "3rem" }],
			},
		};
		const doc = exportToBuilderSchema(lexicalJson);
		expect(doc.blocks).toHaveLength(1);
		expect(doc.blocks[0]!.type).toBe("section");
		const section = doc.blocks[0] as any;
		expect(section.props.background).toBe("#ffffff");
		expect(section.children[0]!.type).toBe("columns");
	});

	it("exportToBuilderSchema converts legacy Lexical JSON to BuilderDocument", () => {
		const legacyLexical = {
			root: {
				children: [{ type: "paragraph", children: [{ type: "text", text: "Hello" }] }],
				direction: "ltr",
				format: "",
				indent: 0,
				type: "root",
				version: 1,
			},
		};
		const doc = exportToBuilderSchema(legacyLexical);
		expect(doc.version).toBe(1);
		expect(doc.blocks.length).toBeGreaterThan(0);
		expect(doc.blocks[0]!.type).toBe("section");
	});
});

// ── builder-to-lexical (import) ───────────────────────────────────────────────

describe("importFromBuilderSchema", () => {
	it("null returns null", () => {
		expect(importFromBuilderSchema(null)).toBeNull();
	});

	it("undefined returns null", () => {
		expect(importFromBuilderSchema(undefined)).toBeNull();
	});

	it("empty document returns null", () => {
		expect(importFromBuilderSchema(newBuilderDocument())).toBeNull();
	});

	it("section with columns converts to flat Lexical children", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "s1",
					type: "section",
					children: [
						{
							id: "c1",
							type: "columns",
							columns: [
								{ id: "col1", blocks: [{ id: "b1", type: "button", props: { text: "Go" } }] },
							],
						},
					],
				},
			],
		};
		const state = importFromBuilderSchema(doc);
		expect(state).not.toBeNull();
		expect(state!.root.children).toHaveLength(1);
		expect(state!.root.children[0]!.type).toBe("button");
	});

	it("preserves text node formatting for span nodes", () => {
		const doc = {
			version: 1,
			blocks: [
				{
					id: "s1",
					type: "section",
					children: [
						{
							id: "c1",
							type: "columns",
							columns: [
								{
									id: "col1",
									blocks: [
										{
											id: "r1",
											type: "richText",
											content: [{ _type: "span", text: "Bold text", bold: true }],
										},
									],
								},
							],
						},
					],
				},
			],
		};
		const state = importFromBuilderSchema(doc);
		expect(state).not.toBeNull();
		const para = state!.root.children[0] as any;
		expect(para.type).toBe("paragraph");
		// bold is represented by Lexical's text-format bitmask
		expect(para.children[0]!.type).toBe("text");
		expect(para.children[0]!.format & 1).toBe(1);
	});

	it("imports existing Portable Text arrays", () => {
		const state = importPortableTextToLexicalState([
			{
				_type: "block",
				style: "normal",
				children: [{ _type: "span", text: "Existing content", marks: ["strong"] }],
			},
		]);
		expect(state).not.toBeNull();
		const para = state!.root.children[0] as any;
		expect(para.type).toBe("paragraph");
		expect(para.children[0].text).toBe("Existing content");
		expect(para.children[0].format & 1).toBe(1);
	});
});

// ── newBlockId ────────────────────────────────────────────────────────────────

describe("newBlockId", () => {
	it("returns a string starting with blk_", () => {
		expect(newBlockId()).toMatch(/^blk_/);
	});

	it("returns unique ids", () => {
		const ids = new Set(Array.from({ length: 100 }, () => newBlockId()));
		expect(ids.size).toBe(100);
	});
});
