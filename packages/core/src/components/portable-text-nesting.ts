/**
 * Render-time adaptation for `nestingBlock` layout containers.
 *
 * A nesting block stores its columns under `children`, and each `nestingColumn`
 * stores its blocks under `children` too. That key is reserved
 * in Portable Text for a text block's inline spans, and `@portabletext/toolkit`
 * treats any node with a `children` array of typed objects as a text block, so
 * a container would be misrendered as a paragraph and never reach its
 * component. This remaps `children` to `content` (the key EmDash's own
 * container blocks use) at every level so the renderer routes correctly.
 * Storage is untouched; this is render-only.
 */

function isObject(node: unknown): node is Record<string, unknown> {
	return typeof node === "object" && node !== null;
}

function typeOf(node: unknown): string | undefined {
	if (!isObject(node)) return undefined;
	return typeof node._type === "string" ? node._type : undefined;
}

function childrenOf(node: unknown): unknown[] {
	if (!isObject(node)) return [];
	return Array.isArray(node.children) ? node.children : [];
}

/** Recursively remap `nestingBlock.children` (columns) to `content`. */
export function remapNestingBlocks(blocks: unknown[]): unknown[] {
	return blocks.map((block) => {
		if (typeOf(block) !== "nestingBlock" || !isObject(block)) return block;
		const rest = { ...block };
		delete rest.children;
		return { ...rest, content: remapNestingColumns(childrenOf(block)) };
	});
}

function remapNestingColumns(columns: unknown[]): unknown[] {
	return columns.map((column) => {
		if (typeOf(column) !== "nestingColumn" || !isObject(column)) {
			// Legacy/loose block stored directly under a nesting block — wrap it
			// as a single-block column so it still renders.
			return { _type: "nestingColumn", content: remapNestingBlocks([column]) };
		}
		const rest = { ...column };
		delete rest.children;
		return { ...rest, content: remapNestingBlocks(childrenOf(column)) };
	});
}
