import type { ArbitraryTypedObject } from "@portabletext/types";

import { sanitizeUri } from "../sanitize.js";
import { getStringField, isContentfulLinkPayload } from "../types.js";
import type { ContentfulEntry, ContentfulIncludes } from "../types.js";

export function transformImageBlock(
	entry: ContentfulEntry,
	includes: ContentfulIncludes,
	key: string,
): ArbitraryTypedObject {
	const assetLink = entry.fields.assetFile;
	const assetId = isContentfulLinkPayload(assetLink) ? assetLink.sys.id : undefined;
	const asset = assetId ? includes.assets.get(assetId) : undefined;

	const src = asset?.url ? (asset.url.startsWith("//") ? `https:${asset.url}` : asset.url) : "";
	const linkUrl = getStringField(entry.fields, "linkUrl");

	return {
		_type: "image",
		_key: key,
		asset: {
			src,
			alt: asset?.description ?? asset?.title ?? "",
			width: asset?.width,
			height: asset?.height,
		},
		linkUrl: linkUrl ? sanitizeUri(linkUrl) : undefined,
		size: getStringField(entry.fields, "size") ?? undefined,
	};
}
