/**
 * The video block's Portable Text shape and node attributes. Core's converters
 * use them too.
 */

type FieldCheck = (value: unknown) => boolean;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
export const isString = (value: unknown): value is string => typeof value === "string";
export const isDimension = (value: unknown): value is number =>
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

const isAsset = (value: unknown): value is Record<string, unknown> =>
	isRecord(value) && isString(value._ref) && hasOnly(value, ASSET_FIELDS);

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
export function isVideoBlock(block: unknown): boolean {
	return isRecord(block) && block._type === "video" && hasOnly(block, VIDEO_FIELDS);
}

/** A video block's node attributes. */
export function videoNodeAttrs(block: unknown): Record<string, unknown> {
	const record = isRecord(block) ? block : {};
	const asset = isRecord(record.asset) ? record.asset : {};
	return {
		src: isString(asset.url) ? asset.url : "",
		mediaId: isString(asset._ref) ? asset._ref : null,
		provider: isString(asset.provider) ? asset.provider : null,
		caption: isString(record.caption) ? record.caption : "",
		width: isDimension(record.width) ? record.width : null,
		height: isDimension(record.height) ? record.height : null,
	};
}

/** A video block's fields besides `_type` and `_key`. */
export interface VideoBlockFields {
	asset?: { _ref: string; url?: string; provider?: string };
	caption?: string;
	width?: number;
	height?: number;
}

/** A video node's Portable Text fields, written only when set. */
export function videoBlockFields(attrs: Record<string, unknown>): VideoBlockFields {
	const { src, mediaId, provider, caption, width, height } = attrs;
	const asset: NonNullable<VideoBlockFields["asset"]> = { _ref: isString(mediaId) ? mediaId : "" };
	if (isString(src) && src) asset.url = src;
	if (isString(provider) && provider && provider !== "local") asset.provider = provider;
	// An empty block has no media id, file or provider.
	const empty = !isString(mediaId) && !asset.url && !asset.provider;
	return {
		...(empty ? {} : { asset }),
		...(isString(caption) && caption ? { caption } : {}),
		...(isDimension(width) ? { width } : {}),
		...(isDimension(height) ? { height } : {}),
	};
}
