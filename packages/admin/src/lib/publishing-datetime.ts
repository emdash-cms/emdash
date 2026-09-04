import { parseTimestamp } from "./utils.js";

export interface PublishingDateTimeFields {
	date: Date | undefined;
	time: string;
}

export type PublishingDateTimeError =
	| "missing-date"
	| "missing-time"
	| "invalid-date"
	| "invalid-time"
	| "nonexistent-time"
	| "past";

export type PublishingDateTimeResult =
	| { success: true; date: Date; value: string }
	| { success: false; error: PublishingDateTimeError };

const TIME_PATTERN = /^(?<hours>[01]\d|2[0-3]):(?<minutes>[0-5]\d)$/;

function isValidDate(date: Date | undefined): date is Date {
	return date instanceof Date && !Number.isNaN(date.getTime());
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function publishingInstantToLocalFields(value: string | null): PublishingDateTimeFields {
	if (!value) return { date: undefined, time: "" };
	const instant = parseTimestamp(value);
	if (!isValidDate(instant)) return { date: undefined, time: "" };

	return {
		date: new Date(instant.getFullYear(), instant.getMonth(), instant.getDate(), 12),
		time: `${pad(instant.getHours())}:${pad(instant.getMinutes())}`,
	};
}

export function resolvePublishingLocalDateTime(
	date: Date | undefined,
	time: string,
): PublishingDateTimeResult {
	if (!date) return { success: false, error: "missing-date" };
	if (!isValidDate(date)) return { success: false, error: "invalid-date" };
	if (!time) return { success: false, error: "missing-time" };

	const match = TIME_PATTERN.exec(time);
	if (!match?.groups) return { success: false, error: "invalid-time" };
	const hours = Number(match.groups.hours);
	const minutes = Number(match.groups.minutes);
	const resolved = new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
		hours,
		minutes,
		0,
		0,
	);
	if (
		resolved.getFullYear() !== date.getFullYear() ||
		resolved.getMonth() !== date.getMonth() ||
		resolved.getDate() !== date.getDate() ||
		resolved.getHours() !== hours ||
		resolved.getMinutes() !== minutes
	) {
		return { success: false, error: "nonexistent-time" };
	}

	return { success: true, date: resolved, value: resolved.toISOString() };
}

export function serializeFuturePublishingDateTime(
	date: Date | undefined,
	time: string,
	now = new Date(),
): PublishingDateTimeResult {
	const result = resolvePublishingLocalDateTime(date, time);
	if (!result.success) return result;
	if (result.date.getTime() <= now.getTime()) return { success: false, error: "past" };
	return result;
}

export function publishingFieldsMatchInstant(
	value: string | null,
	date: Date | undefined,
	time: string,
): boolean {
	if (!value || !date) return false;
	const initial = publishingInstantToLocalFields(value);
	return (
		initial.date?.getFullYear() === date.getFullYear() &&
		initial.date.getMonth() === date.getMonth() &&
		initial.date.getDate() === date.getDate() &&
		initial.time === time
	);
}

export function formatPublishingInstant(value: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(parseTimestamp(value));
}

export function formatPublishingInstantWithZone(value: string, locale: string): string {
	const date = parseTimestamp(value);
	const formatted = formatPublishingInstant(value, locale);
	const { timeZone, shortName } = getPublishingTimeZone(date, locale);
	const zone = shortName ?? timeZone;
	return zone ? `${formatted} (${zone})` : formatted;
}

export function getPublishingTimeZone(
	date: Date,
	locale: string,
): {
	timeZone: string | null;
	shortName: string | null;
} {
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
	const shortName =
		new Intl.DateTimeFormat(locale, { timeZoneName: "short" })
			.formatToParts(date)
			.find((part) => part.type === "timeZoneName")?.value ?? null;
	return { timeZone, shortName };
}
