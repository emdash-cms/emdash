/**
 * exportToBuilderSchema — convert Lexical editor state to BuilderDocument.
 *
 * Lexical stores a flat tree (root.children[]) of custom nodes.
 * BuilderDocument has explicit hierarchy: section → columns → blocks.
 *
 * Since the current Lexical nodes don't include section/columns wrappers,
 * we wrap all content in a default section + single column:
 *   BuilderDocument
 *     └── BuilderSectionBlock (auto-generated)
 *         └── BuilderColumnsBlock (auto-generated)
 *             └── column (auto-generated, width=12)
 *                 └── blocks (converted from Lexical root children)
 *
 * TODO (Phase B): Add SectionNode and ColumnsNode to Lexical.
 * When they exist, respect the natural hierarchy instead of wrapping.
 */
import { newBlockId, newBuilderDocument } from "./schema.js";
import type {
	BuilderBlock,
	BuilderColumnsBlock,
	BuilderDocument,
	BuilderSectionBlock,
} from "./schema.js";

// ── Lexical node type → builder block type ────────────────────────────────────

// Extends the base SerializedLexicalNode to include text-node format fields.
// Lexical stores bold/italic/etc as a format bitmask on SerializedTextNode,
// but we also encounter them as flat boolean fields in paragraph children.
interface SerializedLexicalNode {
	type: string;
	version?: number;
	// button
	text?: string;
	variant?: string;
	size?: string;
	// image
	src?: string;
	alt?: string;
	width?: string;
	alignment?: string;
	// container
	background?: string;
	padding?: string;
	maxWidth?: string;
	// spacer
	height?: string;
	// generic
	children?: SerializedLexicalNode[];
	direction?: string;
	format?: string | number;
	indent?: number;
	tag?: string;
	// rich text (text node children)
	_type?: string;
	_key?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	code?: boolean;
	detail?: number;
	mode?: string;
	style?: string;
}

const TEXT_FORMAT_BOLD = 1;
const TEXT_FORMAT_ITALIC = 2;
const TEXT_FORMAT_STRIKETHROUGH = 4;
const TEXT_FORMAT_UNDERLINE = 8;
const TEXT_FORMAT_CODE = 16;

function hasTextFormat(node: SerializedLexicalNode, bit: number): boolean {
	return typeof node.format === "number" && (node.format & bit) !== 0;
}

function lexicalTextToPortableSpan(node: SerializedLexicalNode) {
	return {
		_type: "span",
		_key: node._key ?? newBlockId(),
		text: node.text ?? "",
		...(node.bold === true || hasTextFormat(node, TEXT_FORMAT_BOLD) ? { bold: true } : {}),
		...(node.italic === true || hasTextFormat(node, TEXT_FORMAT_ITALIC) ? { italic: true } : {}),
		...(node.underline === true || hasTextFormat(node, TEXT_FORMAT_UNDERLINE)
			? { underline: true }
			: {}),
		...(node.strikethrough === true || hasTextFormat(node, TEXT_FORMAT_STRIKETHROUGH)
			? { strikethrough: true }
			: {}),
		...(node.code === true || hasTextFormat(node, TEXT_FORMAT_CODE) ? { code: true } : {}),
	};
}

function lexicalNodeToBuilderBlock(node: SerializedLexicalNode): BuilderBlock | null {
	switch (node.type) {
		case "button":
			return {
				id: newBlockId(),
				type: "button",
				props: {
					text: node.text ?? "Button",
					href: "#",
					variant: (node.variant as "primary" | "secondary" | "outline") ?? "primary",
					size: (node.size as "small" | "medium" | "large") ?? "medium",
				},
			};

		case "image":
			return {
				id: newBlockId(),
				type: "image",
				props: {
					src: node.src ?? "",
					alt: node.alt ?? "",
					width: node.width ?? "100%",
					alignment: (node.alignment as "left" | "center" | "right") ?? "center",
				},
			};

		case "container":
			return {
				id: newBlockId(),
				type: "container",
				props: {
					background: node.background ?? "#ffffff",
					padding: node.padding ?? "1rem",
					maxWidth: node.maxWidth ?? "1200px",
				},
			};

		case "spacer":
			return {
				id: newBlockId(),
				type: "spacer",
				props: {
					height: node.height ?? "2rem",
				},
			};

		case "divider":
			return {
				id: newBlockId(),
				type: "divider",
				props: {},
			};

		case "heading":
		case "paragraph":
			// Rich text node — preserve Portable Text paragraph/heading shape.
			if (node.children && node.children.length > 0) {
				const isHeading = node.type === "heading";
				const level =
					isHeading && typeof node.tag === "string"
						? Number(node.tag.replace("h", "")) || 2
						: undefined;

				return {
					id: newBlockId(),
					type: "richText",
					props: {},
					content: [
						{
							_type: isHeading ? "heading" : "paragraph",
							_key: newBlockId(),
							...(level ? { level } : {}),
							children: node.children.map(lexicalTextToPortableSpan),
						},
					],
				};
			}
			// Empty paragraph — skip
			return null;

		case "text":
			if (typeof node.text === "string" && node.text.length > 0) {
				return {
					id: newBlockId(),
					type: "richText",
					props: {},
					content: [
						{
							_type: "paragraph",
							_key: newBlockId(),
							children: [lexicalTextToPortableSpan(node)],
						},
					],
				};
			}
			return null;

		case "root":
			// Root node — process children
			if (node.children && node.children.length > 0) {
				const childBlocks = convertChildren(node.children);
				if (childBlocks.length === 0) return null;

				// Wrap in default section + columns (Phase A workaround)
				// TODO: when SectionNode/ColumnsNode exist in Lexical, use natural hierarchy
				const sectionId = newBlockId();
				const columnsId = newBlockId();

				const section: BuilderSectionBlock = {
					id: sectionId,
					type: "section",
					props: { background: "#ffffff", padding: "1rem", maxWidth: "1200px" },
					children: [
						{
							id: columnsId,
							type: "columns",
							props: { gap: "1rem" },
							columns: [
								{
									id: newBlockId(),
									width: 12,
									blocks: childBlocks,
								},
							],
						} satisfies BuilderColumnsBlock,
					],
				};

				return section;
			}
			return null;

		default:
			// Unknown type — skip
			return null;
	}
}

function convertChildren(nodes: SerializedLexicalNode[]): BuilderBlock[] {
	const blocks: BuilderBlock[] = [];
	for (const node of nodes) {
		const block = lexicalNodeToBuilderBlock(node);
		if (block) blocks.push(block);
	}
	return blocks;
}

/**
 * Convert a raw Lexical JSON object (from editor.getEditorState().toJSON())
 * into a BuilderDocument.
 *
 * Falls back gracefully: if the input is invalid, returns an empty document.
 */
export function exportToBuilderSchema(lexicalJson: unknown): BuilderDocument {
	if (!lexicalJson || typeof lexicalJson !== "object") {
		return newBuilderDocument();
	}

	const state = lexicalJson as { root?: SerializedLexicalNode };

	if (!state.root || !Array.isArray(state.root.children)) {
		return newBuilderDocument();
	}

	const childBlocks = convertChildren(state.root.children);

	if (childBlocks.length === 0) {
		return newBuilderDocument();
	}

	// Wrap in default section + columns (Phase A)
	const sectionId = newBlockId();
	const columnsId = newBlockId();

	const section: BuilderSectionBlock = {
		id: sectionId,
		type: "section",
		props: { background: "#ffffff", padding: "1rem", maxWidth: "1200px" },
		children: [
			{
				id: columnsId,
				type: "columns",
				props: { gap: "1rem" },
				columns: [
					{
						id: newBlockId(),
						width: 12,
						blocks: childBlocks,
					},
				],
			} satisfies BuilderColumnsBlock,
		],
	};

	return { version: 1, blocks: [section] };
}
