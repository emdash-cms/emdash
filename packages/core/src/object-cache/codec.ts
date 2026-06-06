/**
 * Object-cache serialization codec.
 *
 * Cached values are JSON, with one extension: `Date` instances are preserved
 * across the round-trip. EmDash content entries carry `Date` objects for the
 * system timestamp columns (`createdAt`, `updatedAt`, `publishedAt`,
 * `scheduledAt`) and on `cacheHint.lastModified`; plain `JSON.stringify` would
 * silently flatten those to ISO strings, so a value read from cache would no
 * longer be `=== instanceof Date` and downstream `value instanceof Date`
 * branches (cursor encoding, scheduled-visibility checks) would diverge from a
 * fresh database read.
 *
 * Functions and symbol-keyed properties are NOT preserved — callers that cache
 * values carrying either (e.g. content entries with their `.edit` proxy and
 * the non-enumerable `CURSOR_RAW_VALUES` symbol) must reduce to a serializable
 * snapshot before caching and rebuild the non-serializable parts on read. See
 * `query.ts` content snapshot helpers.
 */

/** Tag used to mark a serialized `Date`. Deliberately unlikely to collide. */
const DATE_TAG = "$$emdashDate";

interface TaggedDate {
	[DATE_TAG]: string;
}

function isTaggedDate(value: unknown): value is TaggedDate {
	return (
		typeof value === "object" &&
		value !== null &&
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowing a JSON-parsed value to read the date tag
		typeof (value as Record<string, unknown>)[DATE_TAG] === "string"
	);
}

/**
 * Serialize a value to a cache string, preserving `Date` instances.
 *
 * Uses the JSON replacer's `this` binding to inspect the *original* property
 * value: `JSON.stringify` invokes `Date.prototype.toJSON` before the replacer
 * sees it, so by the time `value` arrives it is already an ISO string. Reading
 * `this[key]` recovers the live `Date` so we can tag it.
 */
export function encode(value: unknown): string {
	return JSON.stringify(value, function (this: Record<string, unknown>, key, val) {
		const original = this[key];
		if (original instanceof Date) {
			return { [DATE_TAG]: original.toISOString() } satisfies TaggedDate;
		}
		return val;
	});
}

/**
 * Parse a cache string produced by {@link encode}, rehydrating tagged `Date`s.
 *
 * Returns `undefined` if the input is not valid JSON (treated as a cache miss
 * by the read-through layer rather than throwing).
 */
export function decode(raw: string): unknown {
	try {
		return JSON.parse(raw, (_key, value) => {
			if (isTaggedDate(value)) {
				return new Date(value[DATE_TAG]);
			}
			return value;
		});
	} catch {
		return undefined;
	}
}
