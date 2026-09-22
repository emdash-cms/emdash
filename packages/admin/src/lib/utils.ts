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

export function formatRelativeTime(dateString: string): string {
	const date = parseTimestamp(dateString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffSecs = Math.floor(diffMs / 1000);
	const diffMins = Math.floor(diffSecs / 60);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffSecs < 60) return "just now";
	if (diffMins < 60) return `${diffMins} min${diffMins === 1 ? "" : "s"} ago`;
	if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
	if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;

	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
	});
}
