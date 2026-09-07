import type { PortableTextBlock, PortableTextMarkDef } from "./types.js";

export const PORTABLE_TEXT_BLOCK_NODE = "emdashPortableTextBlock";
export const PORTABLE_TEXT_BLOCK_ATTR = "emdashPortableTextBlock";
export const PORTABLE_TEXT_KEY_ATTR = "emdashPortableTextKey";
export const PORTABLE_TEXT_MARK_DEF_ATTR = "emdashPortableTextMarkDef";

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

export function portableTextMarkDefFromAttrs(
	attrs: Record<string, unknown> | undefined,
): PortableTextMarkDef | undefined {
	const markDef = attrs?.[PORTABLE_TEXT_MARK_DEF_ATTR];
	if (!isRecord(markDef) || typeof markDef._type !== "string" || typeof markDef._key !== "string") {
		return undefined;
	}
	return { ...markDef, _type: markDef._type, _key: markDef._key };
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
