/**
 * Helpers for round-tripping `datetime` field values through
 * `<input type="datetime-local">`.
 *
 * Datetime fields are instants stored as canonical UTC ISO strings. The
 * browser input has no offset, so conversions use the configured site
 * timezone rather than the browser timezone.
 */

const NAIVE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;
const OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function formatter(timezone: string): Intl.DateTimeFormat {
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
}

function parts(format: Intl.DateTimeFormat, epochMs: number): Record<string, number> {
	const result: Record<string, number> = {};
	for (const part of format.formatToParts(new Date(epochMs))) {
		if (part.type !== "literal") result[part.type] = Number(part.value);
	}
	return result;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function localInputValue(format: Intl.DateTimeFormat, epochMs: number): string {
	const value = parts(format, epochMs);
	return `${value.year}-${pad(value.month!)}-${pad(value.day!)}T${pad(value.hour!)}:${pad(value.minute!)}`;
}

function offsetAt(format: Intl.DateTimeFormat, epochMs: number): number {
	const wholeSecond = Math.floor(epochMs / 1000) * 1000;
	const value = parts(format, wholeSecond);
	return (
		Date.UTC(
			value.year ?? 0,
			(value.month ?? 0) - 1,
			value.day ?? 0,
			value.hour ?? 0,
			value.minute ?? 0,
			value.second ?? 0,
		) - wholeSecond
	);
}

function resolveSiteLocal(value: string, timezone: string): string {
	const match = DATETIME_LOCAL_PATTERN.exec(value);
	if (!match) throw new Error("Invalid datetime-local value");
	const localEpoch = Date.UTC(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		Number(match[4]),
		Number(match[5]),
	);
	const format = formatter(timezone);
	const offsets = new Set<number>();
	for (let delta = -48; delta <= 48; delta += 6) {
		offsets.add(offsetAt(format, localEpoch + delta * 60 * 60 * 1000));
	}
	const candidates = Array.from(offsets, (offset) => localEpoch - offset).filter(
		(candidate) => localInputValue(format, candidate) === value,
	);
	if (new Set(candidates).size !== 1) {
		throw new Error(`The local time ${value} is ambiguous or does not exist in ${timezone}`);
	}
	return new Date(candidates[0]!).toISOString();
}

/** Format a stored datetime field value for the input. */
export function toDatetimeLocalInputValue(value: unknown, timezone = "UTC"): string {
	if (typeof value !== "string" || value === "") return "";
	if (!OFFSET_PATTERN.test(value)) {
		const naive = NAIVE_PATTERN.exec(value);
		if (!naive) return "";
		return value.length === 10 ? `${value}T00:00` : value.slice(0, 16);
	}
	const instant = new Date(value);
	if (Number.isNaN(instant.getTime())) return "";
	return localInputValue(formatter(timezone), instant.getTime());
}

/** Convert an input value (`YYYY-MM-DDTHH:mm`) back to the stored ISO shape. */
export function fromDatetimeLocalInputValue(value: string, timezone = "UTC"): string {
	return value === "" ? "" : resolveSiteLocal(value, timezone);
}
