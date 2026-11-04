import type { ImageValue } from "../fields/types.js";

const FALLBACK_LOCALE = "en";
const FALLBACK_TIMEZONE = "UTC";

/**
 * Convert a post's `publishedAt` value into a valid Date, or null.
 */
export function toPublishedDate(value: unknown): Date | null {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value;
	}
	if (typeof value === "string" || typeof value === "number") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	return null;
}

function isSupportedLocale(locale: string): boolean {
	try {
		return Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0;
	} catch {
		return false;
	}
}

function isSupportedTimeZone(timeZone: string): boolean {
	try {
		Intl.DateTimeFormat(FALLBACK_LOCALE, { timeZone });
		return true;
	} catch {
		return false;
	}
}

/**
 * Create the long-date formatter for the widget's publication dates.
 *
 * An unsupported locale falls back to English and an unrecognized timezone
 * to UTC. `Intl.DateTimeFormat` throws a `RangeError` for either.
 */
export function createPublishedDateFormatter(
	options: { locale?: string; timezone?: string } = {},
): Intl.DateTimeFormat {
	const { locale, timezone } = options;
	return new Intl.DateTimeFormat(locale && isSupportedLocale(locale) ? locale : FALLBACK_LOCALE, {
		dateStyle: "long",
		timeZone: timezone && isSupportedTimeZone(timezone) ? timezone : FALLBACK_TIMEZONE,
	});
}

/**
 * Whether a featured-image value is something `EmDashImage` can render: a
 * media value or an image URL.
 */
export function isThumbnailImage(value: unknown): value is ImageValue | string {
	if (typeof value === "string") return value !== "";
	return (
		typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
	);
}
