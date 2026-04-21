/**
 * blogImage → PT imageBlock
 *
 * Contentful fields: { assetFile: Link<Asset>, linkUrl?: string, size?: "Normal" | "Wide" }
 * PT output: { _type: "imageBlock", asset: { src, alt, width, height }, linkUrl?, size? }
 *
 * The asset URL is resolved from the includes map. At this stage it still
 * points to images.ctfassets.net — the ingestion layer rewrites it to R2
 * after downloading and uploading the asset.
 */
import type {
	ContentfulEntry,
	ContentfulIncludes,
	PTBlock,
} from "../types.js";

import { sanitizeUri } from "../sanitize.js";

export function transformImageBlock(
	entry: ContentfulEntry,
	includes: ContentfulIncludes,
	key: string,
): PTBlock {
	const assetLink = entry.fields.assetFile as
		| { sys?: { id?: string } }
		| undefined;
	const assetId = assetLink?.sys?.id;
	const asset = assetId ? includes.assets.get(assetId) : undefined;

	const src = asset?.url
		? asset.url.startsWith("//")
			? `https:${asset.url}`
			: asset.url
		: "";

	return {
		_type: "imageBlock",
		_key: key,
		asset: {
			src,
			alt: asset?.description ?? asset?.title ?? "",
			width: asset?.width,
			height: asset?.height,
		},
		linkUrl: entry.fields.linkUrl
			? sanitizeUri(entry.fields.linkUrl as string)
			: undefined,
		size: (entry.fields.size as string) ?? undefined,
	};
}
