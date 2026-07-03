export const MEDIA_USAGE_CONTENT_SOURCE_VARIANTS = ["columns", "draft_overlay"] as const;

export type MediaUsageContentSourceVariant = (typeof MEDIA_USAGE_CONTENT_SOURCE_VARIANTS)[number];

export interface ContentMediaUsageSourceKeyInput {
	collectionSlug: string;
	contentId: string;
	sourceVariant: MediaUsageContentSourceVariant;
}

export function isMediaUsageContentSourceVariant(
	value: unknown,
): value is MediaUsageContentSourceVariant {
	return (
		typeof value === "string" &&
		(MEDIA_USAGE_CONTENT_SOURCE_VARIANTS as readonly string[]).includes(value)
	);
}

export function buildContentMediaUsageSourceKey(input: ContentMediaUsageSourceKeyInput): string {
	return `content:${input.collectionSlug}:${input.contentId}:${input.sourceVariant}`;
}
