import type { CacheHint } from "emdash";

export function mergeCacheHints(...hints: Array<CacheHint | undefined>): CacheHint {
	const tags = [...new Set(hints.flatMap((hint) => hint?.tags ?? []))];
	const timestamps = hints.flatMap((hint) =>
		hint?.lastModified ? [hint.lastModified.getTime()] : [],
	);
	const lastModified = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : undefined;

	return {
		...(tags.length > 0 ? { tags } : {}),
		...(lastModified ? { lastModified } : {}),
	};
}
