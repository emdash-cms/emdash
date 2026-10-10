import type { Config, SourceConfig } from "./config.js";

/**
 * What saving a configuration does to a source's items:
 * - `add`: the source is newly enabled, so its records are uploaded.
 * - `remove`: the source is disabled, so its items are deleted.
 * - `reindex`: what a document holds changed, so every record is uploaded again.
 */
export type SourceChange = "add" | "remove" | "reindex";

export interface SourceImpact {
	source: string;
	change: SourceChange;
}

/** A source's settings in a form where equal documents compare equal. */
function comparable(source: SourceConfig): string {
	return JSON.stringify({
		...source,
		includeAuthorNames: source.includeAuthorNames ?? false,
		taxonomies: (source.taxonomies ?? []).toSorted(),
	});
}

/** The sources whose indexed documents differ under `next`, and how. */
export function indexImpact(previous: Config | null, next: Config): SourceImpact[] {
	const ids = new Set([...Object.keys(previous?.sources ?? {}), ...Object.keys(next.sources)]);
	return [...ids].flatMap((source): SourceImpact[] => {
		const before = previous?.sources[source];
		const after = next.sources[source];
		if (!before?.enabled && !after?.enabled) return [];
		if (!before?.enabled) return [{ source, change: "add" }];
		if (!after?.enabled) return [{ source, change: "remove" }];
		return comparable(before) === comparable(after) ? [] : [{ source, change: "reindex" }];
	});
}
