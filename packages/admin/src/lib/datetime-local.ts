/**
 * Helpers for round-tripping `datetime` field values through
 * `<input type="datetime-local">`.
 *
 * Stored field values are full ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`) or
 * date-only (`YYYY-MM-DD`) per the per-field zod schema in
 * `packages/core/src/schema/zod-generator.ts`. The browser input only
 * accepts `YYYY-MM-DDTHH:mm`, so widgets must convert in both directions.
 *
 * The widget treats the value as UTC for a stable round-trip. Using
 * `new Date(...).toISOString()` (the convention in the publish-schedule
 * UI in `ContentEditor.tsx`) would shift values by the local-UTC offset on
 * every save, mutating the persisted time on each edit cycle.
 */

/** Format a stored datetime field value for the input. */
export function toDatetimeLocalInputValue(value: unknown): string {
	if (typeof value !== "string" || value === "") return "";
	// `YYYY-MM-DD` (date-only branch of the schema): pad to UTC midnight.
	if (value.length === 10) return `${value}T00:00`;
	// Full ISO 8601: take the date + `HH:mm` prefix.
	return value.slice(0, 16);
}

/** Convert an input value (`YYYY-MM-DDTHH:mm`) back to the stored ISO shape. */
export function fromDatetimeLocalInputValue(value: string): string {
	return value === "" ? "" : `${value}:00.000Z`;
}
