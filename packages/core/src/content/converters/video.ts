/**
 * The editor's video block: its shape, and its ProseMirror attributes.
 * Keep in sync with the admin editor's `VideoNode`.
 */

import type { PortableTextVideoBlock } from "./types.js";

type FieldCheck = (value: unknown) => boolean;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown) => typeof value === "string";
const isDimension = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 1;

const hasOnly = (record: Record<string, unknown>, fields: Map<string, FieldCheck>) =>
	Object.entries(record).every(
		([key, value]) => value === undefined || (fields.get(key)?.(value) ?? false),
	);

const ASSET_FIELDS = new Map<string, FieldCheck>([
	["_ref", isString],
	["url", isString],
	["provider", isString],
]);

const isAsset = (value: unknown) =>
	isRecord(value) && typeof value._ref === "string" && hasOnly(value, ASSET_FIELDS);

const VIDEO_FIELDS = new Map<string, FieldCheck>([
	["_type", () => true],
	["_key", () => true],
	["asset", isAsset],
	["caption", isString],
	["width", isDimension],
	["height", isDimension],
]);

/**
 * Whether a block is the editor's own video block. A `video` block with other
 * fields, or values of other types, belongs to a plugin.
 */
export function isPortableTextVideoBlock(block: unknown): block is PortableTextVideoBlock {
	return isRecord(block) && block._type === "video" && hasOnly(block, VIDEO_FIELDS);
}

/** ProseMirror attributes of a `videoBlock` node. */
export function videoNodeAttrs(block: PortableTextVideoBlock): Record<string, unknown> {
	return {
		src: block.asset?.url ?? "",
		mediaId: block.asset?._ref ?? null,
		provider: block.asset?.provider,
		caption: block.caption ?? "",
		width: block.width,
		height: block.height,
	};
}

/** A `videoBlock` node's Portable Text fields, writing optional fields only when set. */
export function videoBlockFields(
	attrs: Record<string, unknown>,
): Omit<PortableTextVideoBlock, "_type" | "_key"> {
	const { src, mediaId, provider, caption, width, height } = attrs;
	const asset: NonNullable<PortableTextVideoBlock["asset"]> = {
		_ref: typeof mediaId === "string" ? mediaId : "",
	};
	if (typeof src === "string" && src) asset.url = src;
	if (typeof provider === "string" && provider && provider !== "local") asset.provider = provider;
	// An empty block has no media id, file or provider.
	const empty = typeof mediaId !== "string" && !asset.url && !asset.provider;
	return {
		...(empty ? {} : { asset }),
		...(typeof caption === "string" && caption ? { caption } : {}),
		...(isDimension(width) ? { width } : {}),
		...(isDimension(height) ? { height } : {}),
	};
}
