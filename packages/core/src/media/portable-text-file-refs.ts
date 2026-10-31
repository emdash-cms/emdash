import { isPortableTextVideoBlock } from "../content/converters/video.js";
import { storageKeyFromLocalMediaFileUrl } from "./url.js";

type FindMediaIdsByStorageKeys = (storageKeys: string[]) => Promise<Map<string, string>>;

/**
 * Give each Portable Text image, video, and gallery image that names a local
 * file only by its URL (as Markdown images do) the id of that file's media
 * item in `asset._ref`. The URL stays in `asset.url`. Values without such
 * assets are returned as they are, without a lookup.
 */
export async function linkPortableTextFileUrls(
	values: readonly unknown[],
	findIds: FindMediaIdsByStorageKeys,
): Promise<unknown[]> {
	const assets = values.flatMap((value) => unlinkedFileAssets(value));
	if (assets.length === 0) return [...values];

	const ids = await findIds([...new Set(assets.map((asset) => asset.storageKey))]);
	const linked = new Map<Record<string, unknown>, Record<string, unknown>>();
	for (const { asset, storageKey, url } of assets) {
		const id = ids.get(storageKey);
		if (id) linked.set(asset, { ...asset, _ref: id, url });
	}
	if (linked.size === 0) return [...values];
	return values.map((value) => replaceAssets(value, linked));
}

interface UnlinkedFileAsset {
	asset: Record<string, unknown>;
	storageKey: string;
	url: string;
}

function unlinkedFileAssets(value: unknown): UnlinkedFileAsset[] {
	if (!Array.isArray(value)) return [];
	const found: UnlinkedFileAsset[] = [];
	for (const block of value) {
		for (const asset of blockAssets(block)) {
			const unlinked = unlinkedFileAsset(asset);
			if (unlinked) found.push(unlinked);
		}
	}
	return found;
}

function blockAssets(block: unknown): unknown[] {
	if (!isRecord(block)) return [];
	if (block._type === "image" || isPortableTextVideoBlock(block)) return [block.asset];
	if (block._type === "gallery" && Array.isArray(block.images)) {
		return block.images.map((image: unknown) => (isRecord(image) ? image.asset : undefined));
	}
	return [];
}

function unlinkedFileAsset(asset: unknown): UnlinkedFileAsset | null {
	if (!isRecord(asset)) return null;
	const provider = typeof asset.provider === "string" ? asset.provider.trim() : "";
	if (provider && provider !== "local") return null;
	if (typeof asset.id === "string" && asset.id.trim()) return null;
	const ref = typeof asset._ref === "string" ? asset._ref.trim() : "";
	const refKey = ref ? storageKeyFromLocalMediaFileUrl(ref) : null;
	if (ref && !refKey) return null;
	if (refKey) {
		const url = typeof asset.url === "string" && asset.url.trim() ? asset.url : ref;
		return { asset, storageKey: refKey, url };
	}
	if (typeof asset.url !== "string") return null;
	const urlKey = storageKeyFromLocalMediaFileUrl(asset.url);
	return urlKey ? { asset, storageKey: urlKey, url: asset.url } : null;
}

function replaceAssets(
	value: unknown,
	linked: ReadonlyMap<Record<string, unknown>, Record<string, unknown>>,
): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((block: unknown) => {
		if (!isRecord(block)) return block;
		if (block._type === "gallery" && Array.isArray(block.images)) {
			return {
				...block,
				images: block.images.map((image: unknown) => {
					if (!isRecord(image) || !isRecord(image.asset)) return image;
					const asset = linked.get(image.asset);
					return asset ? { ...image, asset } : image;
				}),
			};
		}
		if (!isRecord(block.asset)) return block;
		const asset = linked.get(block.asset);
		return asset ? { ...block, asset } : block;
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
