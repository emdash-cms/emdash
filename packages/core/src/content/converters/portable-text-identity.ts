import { Extension, Mark, Node, type Extensions } from "@tiptap/core";

import type { PortableTextBlock, PortableTextMarkDef } from "./types.js";

export const PORTABLE_TEXT_BLOCK_NODE = "emdashPortableTextBlock";
export const PORTABLE_TEXT_BLOCK_ATTR = "emdashPortableTextBlock";
export const PORTABLE_TEXT_KEY_ATTR = "emdashPortableTextKey";
export const PORTABLE_TEXT_SPAN_MARK = "emdashPortableTextSpan";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function attrsWithPortableTextKey(
	attrs: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> {
	return { ...attrs, [PORTABLE_TEXT_KEY_ATTR]: key };
}

export function portableTextKeyFromAttrs(
	attrs: Record<string, unknown> | undefined,
): string | undefined {
	const key = attrs?.[PORTABLE_TEXT_KEY_ATTR];
	return typeof key === "string" && key ? key : undefined;
}

export function portableTextSpanKeyFromMarks(marks: unknown[] | undefined): string | undefined {
	for (const mark of marks ?? []) {
		if (!isRecord(mark) || mark.type !== PORTABLE_TEXT_SPAN_MARK || !isRecord(mark.attrs)) continue;
		const key = mark.attrs.key;
		if (typeof key === "string" && key) return key;
	}
	return undefined;
}

export function portableTextMarkDefsFromMarks(marks: unknown[] | undefined): PortableTextMarkDef[] {
	const identity = (marks ?? []).find(
		(mark) => isRecord(mark) && mark.type === PORTABLE_TEXT_SPAN_MARK && isRecord(mark.attrs),
	);
	if (!isRecord(identity) || !isRecord(identity.attrs) || !Array.isArray(identity.attrs.markDefs)) {
		return [];
	}
	return identity.attrs.markDefs.filter(
		(markDef): markDef is PortableTextMarkDef =>
			isRecord(markDef) && typeof markDef._type === "string" && typeof markDef._key === "string",
	);
}

export function portableTextBlockFromAttrs(
	attrs: Record<string, unknown> | undefined,
): PortableTextBlock | undefined {
	const block = attrs?.[PORTABLE_TEXT_BLOCK_ATTR];
	if (!isRecord(block) || typeof block._type !== "string" || typeof block._key !== "string") {
		return undefined;
	}
	return { ...block, _type: block._type, _key: block._key };
}

export const PortableTextIdentityExtension = Extension.create({
	name: "emdashPortableTextIdentity",

	addGlobalAttributes() {
		const hiddenAttribute = { default: null, rendered: false };
		return [
			{
				types: [
					"paragraph",
					"heading",
					"blockquote",
					"codeBlock",
					"htmlBlock",
					"image",
					"horizontalRule",
					"gallery",
					PORTABLE_TEXT_BLOCK_NODE,
				],
				attributes: { [PORTABLE_TEXT_KEY_ATTR]: hiddenAttribute },
			},
		];
	},
});

export const PortableTextSpanIdentity = Mark.create({
	name: PORTABLE_TEXT_SPAN_MARK,
	inclusive: false,
	spanning: false,

	addAttributes() {
		return {
			key: { default: null, rendered: false },
			markDefs: { default: [], rendered: false },
		};
	},

	parseHTML() {
		return [];
	},

	renderHTML() {
		return ["span", 0];
	},
});

export const PortableTextOpaqueBlock = Node.create({
	name: PORTABLE_TEXT_BLOCK_NODE,
	group: "block",
	atom: true,
	selectable: true,
	draggable: true,

	addAttributes() {
		return {
			[PORTABLE_TEXT_BLOCK_ATTR]: { default: null, rendered: false },
		};
	},

	parseHTML() {
		return [{ tag: "div[data-emdash-portable-text-block]" }];
	},

	renderHTML({ node }) {
		const blockType = portableTextBlockFromAttrs(node.attrs)?._type ?? "unknown";
		return [
			"div",
			{
				"data-emdash-portable-text-block": blockType,
				contenteditable: "false",
			},
			`[Unknown block type: ${blockType}]`,
		];
	},
});

export const portableTextIdentityExtensions: Extensions = [
	PortableTextIdentityExtension,
	PortableTextSpanIdentity,
	PortableTextOpaqueBlock,
];
