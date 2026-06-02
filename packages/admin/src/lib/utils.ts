import { i18n } from "@lingui/core";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Regex patterns for slugify
const DIACRITICS_PATTERN = /[\u0300-\u036f]/g;
const WHITESPACE_UNDERSCORE_PATTERN = /[\s_]+/g;
const NON_ALPHANUMERIC_HYPHEN_PATTERN = /[^a-z0-9-]/g;
const MULTIPLE_HYPHENS_PATTERN = /-+/g;
const LEADING_TRAILING_HYPHEN_PATTERN = /^-|-$/g;

/**
 * Merge class names with Tailwind CSS support
 */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Convert a string to a URL-friendly slug.
 *
 * Handles unicode by normalizing to NFD and stripping diacritics.
 */
function getActiveLocale(): string {
	return i18n.locale || "en";
}

function toDate(value: string | Date): Date {
	return value instanceof Date ? value : new Date(value);
}

export function formatDate(value: string | Date, options?: Intl.DateTimeFormatOptions): string {
	return toDate(value).toLocaleDateString(getActiveLocale(), options);
}

export function formatDateTime(value: string | Date, options?: Intl.DateTimeFormatOptions): string {
	return toDate(value).toLocaleString(getActiveLocale(), options);
}

export function formatTime(value: string | Date, options?: Intl.DateTimeFormatOptions): string {
	return toDate(value).toLocaleTimeString(getActiveLocale(), options);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
	return value.toLocaleString(getActiveLocale(), options);
}

export function formatRelativeTime(value: string | Date): string {
	const date = toDate(value);
	const now = new Date();
	const diffSecs = Math.round((date.getTime() - now.getTime()) / 1000);
	const absDiffSecs = Math.abs(diffSecs);
	const rtf = new Intl.RelativeTimeFormat(getActiveLocale(), { numeric: "auto" });

	if (absDiffSecs < 60) return rtf.format(diffSecs, "second");
	if (absDiffSecs < 60 * 60) return rtf.format(Math.round(diffSecs / 60), "minute");
	if (absDiffSecs < 60 * 60 * 24) return rtf.format(Math.round(diffSecs / (60 * 60)), "hour");
	if (absDiffSecs < 60 * 60 * 24 * 7)
		return rtf.format(Math.round(diffSecs / (60 * 60 * 24)), "day");

	return formatDate(date, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
	});
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(DIACRITICS_PATTERN, "")
		.replace(WHITESPACE_UNDERSCORE_PATTERN, "-")
		.replace(NON_ALPHANUMERIC_HYPHEN_PATTERN, "")
		.replace(MULTIPLE_HYPHENS_PATTERN, "-")
		.replace(LEADING_TRAILING_HYPHEN_PATTERN, "");
}
