import type { PageContentBlock } from "../../emdash-env";

type HeroBlock = Extract<PageContentBlock, { _type: "marketing_hero" }>;
type HeroImage = NonNullable<HeroBlock["image"]>;

function absoluteImageUrl(image: HeroImage, origin: string): string | undefined {
	if (image.src) return new URL(image.src, origin).href;
	// Only media in the site's own storage is served by the media file route.
	if ((image.provider ?? "local") !== "local") {
		return image.previewUrl ? new URL(image.previewUrl, origin).href : undefined;
	}
	const storageKey = typeof image.meta?.storageKey === "string" ? image.meta.storageKey : image.id;
	return `${origin}/_emdash/api/media/file/${storageKey}`;
}

/**
 * Fallbacks for `getSeoMeta()` from the page's first hero, used when the
 * page's SEO panel is empty: its subheadline describes the page and its photo
 * is the share image.
 */
export function heroSeoDefaults(blocks: PageContentBlock[] | undefined, origin: string) {
	const hero = blocks?.find((block): block is HeroBlock => block._type === "marketing_hero");
	return {
		defaultDescription: hero?.subheadline?.trim() || undefined,
		defaultOgImage: hero?.image ? absoluteImageUrl(hero.image, origin) : undefined,
	};
}
