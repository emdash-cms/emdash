/**
 * Shared utility helpers used across multiple modules.
 */

/**
 * Type guard for narrowing `unknown` to `Record<string, unknown>` so
 * subsequent `value["key"]` accesses are typesafe without an `as` cast.
 * Excludes arrays (which are also `typeof === "object"`) so consumers
 * checking for "JSON-shaped object" get what they expect.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
