/**
 * The collection and field slug rule.
 */

/** Lowercase letter first, then lowercase letters, digits, and underscores. */
export const SCHEMA_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Maximum length of a collection or field slug. */
export const MAX_SCHEMA_SLUG_LENGTH = 63;

/** Whether `value` is a valid collection or field slug. */
export function isValidSchemaSlug(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_SCHEMA_SLUG_LENGTH &&
		SCHEMA_SLUG_PATTERN.test(value)
	);
}
