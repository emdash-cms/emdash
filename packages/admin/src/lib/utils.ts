import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export { slugify } from "../slugify.js";

// Regex patterns for parseTimestamp
const NAIVE_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
const TIMEZONE_DESIGNATOR_PATTERN = /(?:[zZ]|[+-]\d\d(?::?\d\d)?)$/;

/**
 * Merge class names with Tailwind CSS support
 */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Parse a timestamp string into a Date, treating values without a timezone as UTC.
 *
 * SQLite `datetime('now')` returns `YYYY-MM-DD HH:MM:SS` with no designator, which JavaScript would otherwise read as local time.
 */
export function parseTimestamp(value: string): Date {
	const hasTime = NAIVE_DATETIME_PATTERN.test(value);
	const hasZone = TIMEZONE_DESIGNATOR_PATTERN.test(value);
	if (hasTime && !hasZone) {
		return new Date(value.replace(" ", "T") + "Z");
	}
	return new Date(value);
}

/**
 * Format a timestamp as "3 minutes ago" in the admin's locale.
 *
 * `Intl.RelativeTimeFormat` writes the phrase itself, so nothing here goes through the message
 * catalog — a wrapped English template would still be wrong in every language it has no plural
 * rules for. Anything older than a week reads as a date instead.
 */
export function formatRelativeTime(dateString: string, locale: string): string {
	const date = parseTimestamp(dateString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffSecs = Math.floor(diffMs / 1000);
	const diffMins = Math.floor(diffSecs / 60);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	if (diffSecs < 60) return relativeTime.format(0, "second");
	if (diffMins < 60) return relativeTime.format(-diffMins, "minute");
	if (diffHours < 24) return relativeTime.format(-diffHours, "hour");
	if (diffDays < 7) return relativeTime.format(-diffDays, "day");

	return formatDate(date, locale, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
	});
}

/**
 * Format a timestamp in the admin's locale.
 *
 * Every date in the admin goes through here rather than `toLocaleDateString()` with no locale,
 * which follows the browser's language and leaves a Hebrew admin printing English months.
 */
export function formatDate(
	value: string | Date,
	locale: string,
	options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
	const date = typeof value === "string" ? parseTimestamp(value) : value;
	return new Intl.DateTimeFormat(locale, options).format(date);
}

/** U+2068 FIRST STRONG ISOLATE and U+2069 POP DIRECTIONAL ISOLATE, written as escapes because the
 * characters themselves are invisible in source. */
const FIRST_STRONG_ISOLATE = "\u2068";
const POP_DIRECTIONAL_ISOLATE = "\u2069";

/**
 * Wrap a formatted value in Unicode isolates so the surrounding text cannot reorder it.
 *
 * A date carries digits and punctuation, whose direction the bidirectional algorithm takes from
 * the paragraph around them: "22 בספט׳ 2026, 22:48" in an RTL panel renders with the comma
 * against the wrong number. In JSX prefer `<bdi>`, which does the same thing as markup; this is
 * for values interpolated into a translated sentence, where there is no element to wrap them in.
 */
export function isolate(text: string): string {
	return `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}
