/** Scalar values accepted by indexed content-field filters. */
export type ContentFieldFilterScalar = string | number | boolean | null;

/** Inclusive or exclusive bounds for an indexed scalar field. */
export interface ContentFieldRangeFilter {
	gt?: string | number;
	gte?: string | number;
	lt?: string | number;
	lte?: string | number;
}

/** Match any one of the supplied values. */
export interface ContentFieldInFilter {
	in: Array<string | number | boolean>;
}

/** A single indexed content-field condition. */
export type ContentFieldFilterValue =
	| ContentFieldFilterScalar
	| ContentFieldRangeFilter
	| ContentFieldInFilter;

/**
 * Indexed custom-field filters, combined with AND semantics.
 *
 * A scalar performs an exact match, `null` matches missing values, `{ in: [...] }`
 * performs membership matching, and range bounds can be combined.
 */
export type ContentFieldFilters = Record<string, ContentFieldFilterValue>;

/**
 * Taxonomy-term filters, keyed by taxonomy name.
 *
 * An entry matches a key when it carries **any** of that key's term slugs, and
 * must match **every** key: OR within a taxonomy, AND across taxonomies. This
 * mirrors `ContentFieldFilters`, which ANDs its keys, and matches how the
 * filters read in a UI: two terms of one taxonomy widen a search, two
 * taxonomies narrow it.
 *
 * Slugs are resolved per locale, as terms are elsewhere.
 */
export type ContentTermFilters = Record<string, string[]>;
