import { z } from "zod";

export type DatetimeNormalizationKind = "canonical" | "offset" | "naive";

export type DatetimeNormalizationErrorCode =
	| "invalid"
	| "invalid_timezone"
	| "offset_required"
	| "ambiguous"
	| "nonexistent";

export class DatetimeNormalizationError extends Error {
	constructor(
		public readonly code: DatetimeNormalizationErrorCode,
		public readonly value: unknown,
		public readonly timezone: string,
	) {
		const detail =
			code === "ambiguous"
				? "occurs more than once because of a daylight-saving transition"
				: code === "nonexistent"
					? "does not exist because of a daylight-saving transition"
					: code === "invalid_timezone"
						? `uses an invalid site timezone (${timezone})`
						: code === "offset_required"
							? "must include Z or an explicit UTC offset"
							: "is not a valid ISO 8601 datetime";
		super(`Datetime ${JSON.stringify(value)} ${detail}`);
		this.name = "DatetimeNormalizationError";
	}
}

export interface DatetimeFieldDescriptor {
	slug: string;
	type: "datetime" | "repeater";
	datetimeSubFields?: readonly string[];
}

export interface NormalizedDatetime {
	value: string;
	kind: DatetimeNormalizationKind;
}

export interface NormalizedContentDatetimes {
	value: Record<string, unknown>;
	changedCount: number;
	naiveCount: number;
}

interface LocalDatetimeParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	millisecond: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NAIVE_DATETIME_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
const EXPLICIT_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const EXPLICIT_DATETIME_SCHEMA = z.iso
	.datetime({ offset: true })
	.or(z.iso.datetime({ offset: true, precision: -1 }));
const OFFSET_SAMPLE_RANGE_MS = 48 * 60 * 60 * 1000;
const OFFSET_SAMPLE_STEP_MS = 6 * 60 * 60 * 1000;

function parseNaiveDatetime(value: string): LocalDatetimeParts | null {
	const match = NAIVE_DATETIME_PATTERN.exec(value);
	if (!match) return null;
	const parts: LocalDatetimeParts = {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
		hour: Number(match[4] ?? 0),
		minute: Number(match[5] ?? 0),
		second: Number(match[6] ?? 0),
		millisecond: Number((match[7] ?? "0").padEnd(3, "0")),
	};
	const check = new Date(
		Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second,
			parts.millisecond,
		),
	);
	if (
		check.getUTCFullYear() !== parts.year ||
		check.getUTCMonth() + 1 !== parts.month ||
		check.getUTCDate() !== parts.day ||
		check.getUTCHours() !== parts.hour ||
		check.getUTCMinutes() !== parts.minute ||
		check.getUTCSeconds() !== parts.second ||
		check.getUTCMilliseconds() !== parts.millisecond
	) {
		return null;
	}
	return parts;
}

function zonedFormatter(timezone: string, value: unknown): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
	} catch {
		throw new DatetimeNormalizationError("invalid_timezone", value, timezone);
	}
}

function zonedParts(
	formatter: Intl.DateTimeFormat,
	epochMs: number,
): Omit<LocalDatetimeParts, "millisecond"> {
	const values: Record<string, number> = {};
	for (const part of formatter.formatToParts(new Date(epochMs))) {
		if (part.type !== "literal") values[part.type] = Number(part.value);
	}
	return {
		year: values.year ?? 0,
		month: values.month ?? 0,
		day: values.day ?? 0,
		hour: values.hour ?? 0,
		minute: values.minute ?? 0,
		second: values.second ?? 0,
	};
}

function timezoneOffsetMs(formatter: Intl.DateTimeFormat, epochMs: number): number {
	const wholeSecond = Math.floor(epochMs / 1000) * 1000;
	const parts = zonedParts(formatter, wholeSecond);
	return (
		Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
		wholeSecond
	);
}

function sameLocalDatetime(
	formatter: Intl.DateTimeFormat,
	epochMs: number,
	expected: LocalDatetimeParts,
): boolean {
	const actual = zonedParts(formatter, epochMs);
	return (
		actual.year === expected.year &&
		actual.month === expected.month &&
		actual.day === expected.day &&
		actual.hour === expected.hour &&
		actual.minute === expected.minute &&
		actual.second === expected.second &&
		new Date(epochMs).getUTCMilliseconds() === expected.millisecond
	);
}

function resolveNaiveDatetime(value: string, timezone: string, parts: LocalDatetimeParts): string {
	const formatter = zonedFormatter(timezone, value);
	const localEpoch = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
		parts.millisecond,
	);
	const offsets = new Set<number>();
	for (
		let sample = localEpoch - OFFSET_SAMPLE_RANGE_MS;
		sample <= localEpoch + OFFSET_SAMPLE_RANGE_MS;
		sample += OFFSET_SAMPLE_STEP_MS
	) {
		offsets.add(timezoneOffsetMs(formatter, sample));
	}

	const candidates = new Set<number>();
	for (const offset of offsets) {
		const candidate = localEpoch - offset;
		if (sameLocalDatetime(formatter, candidate, parts)) candidates.add(candidate);
	}
	if (candidates.size === 0) {
		throw new DatetimeNormalizationError("nonexistent", value, timezone);
	}
	if (candidates.size > 1) {
		throw new DatetimeNormalizationError("ambiguous", value, timezone);
	}
	const candidate = candidates.values().next().value;
	if (candidate === undefined) {
		throw new DatetimeNormalizationError("nonexistent", value, timezone);
	}
	return new Date(candidate).toISOString();
}

export function normalizeDatetime(value: unknown, timezone: string): NormalizedDatetime {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throw new DatetimeNormalizationError("invalid", value, timezone);
		}
		return { value: value.toISOString(), kind: "offset" };
	}
	if (typeof value !== "string") {
		throw new DatetimeNormalizationError("invalid", value, timezone);
	}
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			const unquoted: unknown = JSON.parse(value);
			if (typeof unquoted === "string") {
				const normalized = normalizeDatetime(unquoted, timezone);
				return {
					value: normalized.value,
					kind: normalized.kind === "naive" ? "naive" : "offset",
				};
			}
		} catch {
			throw new DatetimeNormalizationError("invalid", value, timezone);
		}
	}

	const naive = parseNaiveDatetime(value);
	if (naive) {
		return { value: resolveNaiveDatetime(value, timezone, naive), kind: "naive" };
	}
	if (!EXPLICIT_OFFSET_PATTERN.test(value)) {
		throw new DatetimeNormalizationError("invalid", value, timezone);
	}
	if (!EXPLICIT_DATETIME_SCHEMA.safeParse(value).success) {
		throw new DatetimeNormalizationError("invalid", value, timezone);
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new DatetimeNormalizationError("invalid", value, timezone);
	}
	const normalized = parsed.toISOString();
	return { value: normalized, kind: value === normalized ? "canonical" : "offset" };
}

export function normalizeExplicitDatetime(value: unknown): string {
	const normalized = normalizeDatetime(value, "UTC");
	if (normalized.kind === "naive") {
		throw new DatetimeNormalizationError("offset_required", value, "UTC");
	}
	return normalized.value;
}

export function normalizeContentDatetimes(
	data: Record<string, unknown>,
	fields: readonly DatetimeFieldDescriptor[],
	timezone: string,
): NormalizedContentDatetimes {
	let value = data;
	let changedCount = 0;
	let naiveCount = 0;
	const write = (slug: string, next: unknown) => {
		if (value === data) value = { ...data };
		value[slug] = next;
	};

	for (const field of fields) {
		const current = data[field.slug];
		if (current === null || current === undefined || current === "") continue;
		if (field.type === "datetime") {
			const normalized = normalizeDatetime(current, timezone);
			if (normalized.kind === "naive") naiveCount++;
			if (!Object.is(normalized.value, current)) {
				changedCount++;
				write(field.slug, normalized.value);
			}
			continue;
		}

		if (!Array.isArray(current) || !field.datetimeSubFields?.length) continue;
		let rows = current;
		for (const [index, row] of current.entries()) {
			if (!isRecord(row)) continue;
			let nextRow = row;
			for (const subField of field.datetimeSubFields) {
				const nested = nextRow[subField];
				if (nested === null || nested === undefined || nested === "") continue;
				const normalized = normalizeDatetime(nested, timezone);
				if (normalized.kind === "naive") naiveCount++;
				if (!Object.is(normalized.value, nested)) {
					changedCount++;
					if (nextRow === row) nextRow = { ...nextRow };
					nextRow[subField] = normalized.value;
				}
			}
			if (nextRow !== row) {
				if (rows === current) rows = [...current];
				rows[index] = nextRow;
			}
		}
		if (rows !== current) write(field.slug, rows);
	}

	return { value, changedCount, naiveCount };
}
