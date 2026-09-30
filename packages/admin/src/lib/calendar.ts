/**
 * Calendar placement and formatting.
 *
 * Day keys (`YYYY-MM-DD`) and month keys (`YYYY-MM`) name calendar days in
 * the site's time zone. Grid arithmetic runs on UTC dates, so the browser's
 * own offset never shifts a day.
 */

import type { CalendarEntry } from "./api/calendar.js";
import { calendarEntryKey } from "./api/calendar.js";

export type CalendarState = "published" | "scheduled" | "update" | "overdue";

export const CALENDAR_STATES: readonly CalendarState[] = [
	"published",
	"scheduled",
	"update",
	"overdue",
];
export type CalendarView = "month" | "agenda";

/** Search params; list values are comma-separated. */
export interface CalendarSearch {
	view?: CalendarView;
	month?: string;
	collections?: string;
	locales?: string;
	states?: string;
	/** The entry open in the side panel, as its `CalendarItem.key`. */
	entry?: string;
}

export interface CalendarFilterValues {
	collections: readonly string[];
	locales: readonly string[];
	states: readonly CalendarState[];
}

export interface CalendarItem extends CalendarEntry {
	key: string;
	time: number;
	day: string;
	state: CalendarState;
}

/** Schedules publish at the next minute sweep; the grace allows for one more. */
export const OVERDUE_GRACE_MS = 2 * 60_000;

const DAY_MS = 86_400_000;
/** UTC offsets run from −12 to +14 hours today; historical local mean time reached almost ±16. */
const ZONE_MARGIN_MS = 16 * 3_600_000;
/** The API's datetimes, and the day keys here, have four-digit years. */
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;
const MAX_TIME = Date.UTC(MAX_YEAR, 11, 31, 23, 59, 59, 999);
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const ENTRY_KEY_PATTERN = /^[a-z][a-z0-9_]*:[^:\s]{1,128}:(published|scheduled)$/;
const MAX_LIST_VALUES = 50;
const MAX_LIST_VALUE_LENGTH = 64;

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

function utcDayKey(time: number): string {
	const date = new Date(time);
	return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Midnight UTC of a day key, for arithmetic and for UTC-pinned formatters. */
export function dayKeyToUTC(day: string): number {
	const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
	return Date.UTC(year, month - 1, date);
}

export function isMonthKey(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = MONTH_PATTERN.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	return year >= MIN_YEAR && year <= MAX_YEAR && month >= 1 && month <= 12;
}

/**
 * Whether a range cut off at the entry cap stopped before the month's end.
 * `loadedThrough` is the day of the last loaded entry, which may itself be
 * only partly loaded.
 */
export function isMonthCutOff(month: string, loadedThrough: string | undefined): boolean {
	return loadedThrough !== undefined && loadedThrough.slice(0, 7) <= month;
}

export function shiftDay(day: string, delta: number): string {
	return utcDayKey(dayKeyToUTC(day) + delta * DAY_MS);
}

export function shiftMonth(month: string, delta: number): string {
	const [year = 1970, index = 1] = month.split("-").map(Number);
	return utcDayKey(Date.UTC(year, index - 1 + delta, 1)).slice(0, 7);
}

/** Every day from the week containing the 1st to the week containing the last day. */
export function monthGridDays(month: string, weekStartsOn: number): string[] {
	const [year = 1970, index = 1] = month.split("-").map(Number);
	const first = Date.UTC(year, index - 1, 1);
	const offset = (new Date(first).getUTCDay() - weekStartsOn + 7) % 7;
	const length = new Date(Date.UTC(year, index, 0)).getUTCDate();
	const weeks = Math.ceil((offset + length) / 7);
	return Array.from({ length: weeks * 7 }, (_, day) => utcDayKey(first + (day - offset) * DAY_MS));
}

/** The instants that can fall on the given days in any time zone. */
export function fetchRange(days: readonly string[]): { from: string; to: string } {
	const first = dayKeyToUTC(days[0] ?? "1970-01-01");
	const last = dayKeyToUTC(days.at(-1) ?? "1970-01-01");
	return {
		from: new Date(first - ZONE_MARGIN_MS).toISOString(),
		to: new Date(Math.min(last + DAY_MS + ZONE_MARGIN_MS, MAX_TIME)).toISOString(),
	};
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

export function dayKeyInZone(time: number, timeZone: string): string {
	let formatter = dayFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		dayFormatters.set(timeZone, formatter);
	}
	const parts = formatter.formatToParts(time);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((entry) => entry.type === type)?.value ?? "";
	return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

export function calendarState(
	entry: Pick<CalendarEntry, "kind" | "status" | "at">,
	now: number,
): CalendarState {
	if (entry.kind === "published") return "published";
	if (now - Date.parse(entry.at) > OVERDUE_GRACE_MS) return "overdue";
	return entry.status === "published" ? "update" : "scheduled";
}

/**
 * Places entries on site-zone days, in time order, then collection order,
 * locale, and title. Entries whose time does not parse are left out.
 *
 * States are judged at `loadedAt`, when the entries were fetched: a schedule
 * that passed after that may already have published.
 */
export function toCalendarItems(
	entries: readonly CalendarEntry[],
	options: { timeZone: string; loadedAt: number; collectionOrder: readonly string[] },
): CalendarItem[] {
	const rank = (slug: string) => {
		const index = options.collectionOrder.indexOf(slug);
		return index === -1 ? options.collectionOrder.length : index;
	};
	return entries
		.flatMap((entry) => {
			const time = Date.parse(entry.at);
			if (Number.isNaN(time)) return [];
			return [
				{
					...entry,
					key: calendarEntryKey(entry),
					time,
					day: dayKeyInZone(time, options.timeZone),
					state: calendarState(entry, options.loadedAt),
				},
			];
		})
		.toSorted(
			(a, b) =>
				a.time - b.time ||
				rank(a.collection) - rank(b.collection) ||
				a.locale.localeCompare(b.locale) ||
				a.title.localeCompare(b.title),
		);
}

export function groupByDay(items: readonly CalendarItem[]): Map<string, CalendarItem[]> {
	const days = new Map<string, CalendarItem[]>();
	for (const item of items) {
		const list = days.get(item.day);
		if (list) list.push(item);
		else days.set(item.day, [item]);
	}
	return days;
}

/** The largest whole unit of a span: minutes under an hour, hours under two days, then days. */
function durationParts(ms: number): { value: number; unit: "minute" | "hour" | "day" } {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return { value: minutes, unit: "minute" };
	const hours = Math.round(ms / 3_600_000);
	if (hours < 48) return { value: hours, unit: "hour" };
	return { value: Math.round(ms / DAY_MS), unit: "day" };
}

/** How long ago, such as "12 minutes ago". */
export function formatTimeAgo(ms: number, locale: string): string {
	const { value, unit } = durationParts(ms);
	return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-value, unit);
}

/** A short span, such as "12 min" or "3 hr". */
export function formatShortDuration(ms: number, locale: string): string {
	const { value, unit } = durationParts(ms);
	return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(value);
}

export function isCalendarState(value: string): value is CalendarState {
	return (CALENDAR_STATES as readonly string[]).includes(value);
}

/** Distinct, trimmed values of a comma-separated search param, bounded in count and length. */
export function readList(value: unknown): string[] {
	if (typeof value !== "string") return [];
	const values = new Set<string>();
	for (const part of value.split(",")) {
		const item = part.trim();
		if (item && item.length <= MAX_LIST_VALUE_LENGTH) values.add(item);
		if (values.size === MAX_LIST_VALUES) break;
	}
	return [...values];
}

export function toListParam(values: readonly string[]): string | undefined {
	return values.length > 0 ? values.join(",") : undefined;
}

export function isEntryKey(value: unknown): value is string {
	return typeof value === "string" && ENTRY_KEY_PATTERN.test(value);
}

export function parseCalendarSearch(search: Record<string, unknown>): CalendarSearch {
	return {
		view: search.view === "month" || search.view === "agenda" ? search.view : undefined,
		month: isMonthKey(search.month) ? search.month : undefined,
		collections: toListParam(readList(search.collections)),
		locales: toListParam(readList(search.locales)),
		states: toListParam(readList(search.states).filter(isCalendarState)),
		entry: isEntryKey(search.entry) ? search.entry : undefined,
	};
}

/** Keeps items matching every filter; an empty filter matches everything. */
export function filterItems(
	items: readonly CalendarItem[],
	filters: CalendarFilterValues,
): CalendarItem[] {
	return items.filter(
		(item) =>
			(filters.collections.length === 0 || filters.collections.includes(item.collection)) &&
			(filters.locales.length === 0 || filters.locales.includes(item.locale)) &&
			(filters.states.length === 0 || filters.states.includes(item.state)),
	);
}

const COLLECTION_COLORS = ["blue", "purple", "teal", "green", "neutral"] as const;
export type CollectionColor = (typeof COLLECTION_COLORS)[number];

export interface CalendarDisplay {
	locale: string;
	timeZone: string;
	viewerZoneDiffers: boolean;
	zoneName: string;
	viewerZoneName: string;
	/** Short zone names such as "UTC" or "GMT+1", which depend on the date for zones with DST. */
	zoneShortName(time: number): string;
	viewerZoneShortName(time: number): string;
	showLocale: boolean;
	/** Whether the day falls on the admin locale's weekend. */
	isWeekend(day: string): boolean;
	formatTime(time: number): string;
	/** Browser-zone time, prefixed with the weekday when its date differs from the site's. */
	formatViewerTime(time: number): string;
	formatDateTime(time: number): string;
	monthTitle(month: string): string;
	weekday(day: string): string;
	weekdayShort(day: string): string;
	monthDay(day: string): string;
	monthDayShort(day: string): string;
	fullDate(day: string): string;
	dayNumber(day: string): string;
	collection(slug: string): { label: string; color: CollectionColor };
}

export interface CalendarDisplayOptions {
	locale: string;
	timeZone: string | undefined;
	collections: ReadonlyArray<{ slug: string; label: string }>;
	showLocale: boolean;
	viewerTimeZone?: string;
}

function isTimeZone(value: string | undefined): value is string {
	if (!value) return false;
	try {
		return Boolean(
			new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone,
		);
	} catch {
		return false;
	}
}

/** "Eastern Time" for regional zones; "Coordinated Universal Time" for UTC and fixed offsets. */
function zoneDisplayName(locale: string, timeZone: string): string {
	const fixed = timeZone === "UTC" || timeZone.startsWith("Etc/");
	const part = new Intl.DateTimeFormat(locale, {
		timeZone,
		timeZoneName: fixed ? "long" : "longGeneric",
	})
		.formatToParts(Date.now())
		.find((entry) => entry.type === "timeZoneName");
	return part?.value ?? timeZone;
}

function shortZoneNameFormatter(locale: string, timeZone: string) {
	const formatter = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" });
	return (time: number) =>
		formatter.formatToParts(time).find((entry) => entry.type === "timeZoneName")?.value ?? timeZone;
}

type LocaleWithWeekInfo = Intl.Locale & {
	getWeekInfo?: () => { weekend?: number[] };
	weekInfo?: { weekend?: number[] };
};

/** The locale's weekend as `getUTCDay` numbers, or Saturday and Sunday where `Intl` can't tell. */
function weekendDays(locale: string): ReadonlySet<number> {
	let weekend: number[] | undefined;
	try {
		const info = new Intl.Locale(locale) as LocaleWithWeekInfo;
		weekend = (info.getWeekInfo?.() ?? info.weekInfo)?.weekend;
	} catch {
		weekend = undefined;
	}
	return new Set(weekend?.length ? weekend.map((day) => day % 7) : [6, 0]);
}

/** Formatters for day keys: pinned to UTC and the Gregorian calendar the grid uses. */
function dayFormatter(locale: string, options: Intl.DateTimeFormatOptions) {
	const formatter = new Intl.DateTimeFormat(locale, {
		...options,
		timeZone: "UTC",
		calendar: "gregory",
	});
	return (day: string) => formatter.format(dayKeyToUTC(day));
}

export function createCalendarDisplay(options: CalendarDisplayOptions): CalendarDisplay {
	const { locale, showLocale } = options;
	const timeZone = isTimeZone(options.timeZone) ? options.timeZone : "UTC";
	const detectedViewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const viewerTimeZone = isTimeZone(options.viewerTimeZone)
		? options.viewerTimeZone
		: isTimeZone(detectedViewerZone)
			? detectedViewerZone
			: timeZone;
	const zoneName = zoneDisplayName(locale, timeZone);
	const viewerZoneName = zoneDisplayName(locale, viewerTimeZone);
	const weekend = weekendDays(locale);

	const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" });
	const dateTime = new Intl.DateTimeFormat(locale, {
		timeZone,
		calendar: "gregory",
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	});
	const viewerTime = new Intl.DateTimeFormat(locale, {
		timeZone: viewerTimeZone,
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	});
	const viewerDayTime = new Intl.DateTimeFormat(locale, {
		timeZone: viewerTimeZone,
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	});
	const monthTitle = new Intl.DateTimeFormat(locale, {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
		calendar: "gregory",
	});

	const colors = new Map(
		options.collections.map((collection, index) => [
			collection.slug,
			{
				label: collection.label,
				color: COLLECTION_COLORS[index % COLLECTION_COLORS.length] ?? "neutral",
			},
		]),
	);

	return {
		locale,
		timeZone,
		viewerZoneDiffers: viewerTimeZone !== timeZone && viewerZoneName !== zoneName,
		zoneName,
		viewerZoneName,
		zoneShortName: shortZoneNameFormatter(locale, timeZone),
		viewerZoneShortName: shortZoneNameFormatter(locale, viewerTimeZone),
		showLocale,
		isWeekend: (day) => weekend.has(new Date(dayKeyToUTC(day)).getUTCDay()),
		formatTime: (value) => time.format(value),
		formatViewerTime: (value) =>
			dayKeyInZone(value, viewerTimeZone) === dayKeyInZone(value, timeZone)
				? viewerTime.format(value)
				: viewerDayTime.format(value),
		formatDateTime: (value) => dateTime.format(value),
		monthTitle: (month) => monthTitle.format(dayKeyToUTC(`${month}-01`)),
		weekday: dayFormatter(locale, { weekday: "long" }),
		weekdayShort: dayFormatter(locale, { weekday: "short" }),
		monthDay: dayFormatter(locale, { month: "long", day: "numeric" }),
		monthDayShort: dayFormatter(locale, { month: "short", day: "numeric" }),
		fullDate: dayFormatter(locale, {
			weekday: "long",
			month: "long",
			day: "numeric",
			year: "numeric",
		}),
		dayNumber: dayFormatter(locale, { day: "numeric" }),
		collection: (slug) => colors.get(slug) ?? { label: slug, color: "neutral" },
	};
}
