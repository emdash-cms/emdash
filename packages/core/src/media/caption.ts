interface CaptionedMedia {
	caption?: string;
	meta?: Record<string, unknown>;
}

export function getMediaCaption(value: { caption?: unknown; meta?: unknown }): string | undefined {
	if (typeof value.caption === "string") return value.caption;
	if (
		value.meta &&
		typeof value.meta === "object" &&
		"caption" in value.meta &&
		typeof value.meta.caption === "string"
	) {
		return value.meta.caption;
	}
	return undefined;
}

/** Keep the legacy metadata alias consistent with the per-use caption. */
export function syncMediaCaption<T extends CaptionedMedia>(value: T): T {
	const caption = getMediaCaption(value);
	if (caption === undefined) return value;
	return {
		...value,
		caption,
		...(value.meta && Object.hasOwn(value.meta, "caption")
			? { meta: { ...value.meta, caption } }
			: {}),
	};
}
