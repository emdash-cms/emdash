/**
 * How much of one reference field's selection a render wants.
 *
 * `true` is the first page at the default limit — the common case, where a
 * field holds one entry or a handful. The object form is for a field that can
 * hold many, and for walking past the first page with the cursor the previous
 * page returned.
 */
export type ReferenceQuery = true | { limit?: number; cursor?: string };

/**
 * The selection a caller opts into, by field slug. A field mapped to
 * `undefined` is not requested, so a render can name one conditionally without
 * building the object in two branches.
 */
export type ReferenceSelection = Record<string, ReferenceQuery | undefined>;
