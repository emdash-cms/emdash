import { fromString as cidFromString, toString as cidToString } from "@atcute/cid";

const DID_METHOD = "[a-z0-9]+";
const DID_ID_SEGMENT = "(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+";
const DID = new RegExp(`^did:${DID_METHOD}:${DID_ID_SEGMENT}(?::${DID_ID_SEGMENT})*$`);
const RECORD_KEY = /^[A-Za-z0-9._~:-]{1,512}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export interface ParsedAtUri {
	authority: string;
	collection: string;
	rkey: string;
}

export interface ParsedInstant {
	seconds: bigint;
	fraction: string;
}

export function isDid(value: unknown): value is string {
	return typeof value === "string" && DID.test(value);
}

export function assertDid(value: unknown, field: string): asserts value is string {
	if (!isDid(value)) throw new TypeError(`${field} must be a valid DID`);
}

export function assertCanonicalCid(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string") throw new TypeError(`${field} must be a canonical CID`);
	try {
		const cid = cidFromString(value);
		if (cidToString(cid) !== value) throw new TypeError();
	} catch {
		throw new TypeError(`${field} must be a canonical CID`);
	}
}

export function parseAtUri(value: unknown, field: string): ParsedAtUri {
	if (typeof value !== "string" || !value.startsWith("at://")) {
		throw new TypeError(`${field} must be an at:// record URI`);
	}
	const path = value.slice(5);
	const firstSlash = path.indexOf("/");
	const secondSlash = path.indexOf("/", firstSlash + 1);
	if (
		firstSlash <= 0 ||
		secondSlash <= firstSlash + 1 ||
		path.slice(secondSlash + 1).includes("/")
	) {
		throw new TypeError(`${field} must include one collection and record key`);
	}
	const authority = path.slice(0, firstSlash);
	const collection = path.slice(firstSlash + 1, secondSlash);
	const rkey = path.slice(secondSlash + 1);
	assertDid(authority, `${field} authority`);
	if (!RECORD_KEY.test(rkey) || rkey === "." || rkey === "..") {
		throw new TypeError(`${field} must have a valid record key`);
	}
	return { authority, collection, rkey };
}

function daysFromCivil(year: bigint, month: bigint, day: bigint): bigint {
	const adjustedYear = year - (month <= 2n ? 1n : 0n);
	const era = (adjustedYear >= 0n ? adjustedYear : adjustedYear - 399n) / 400n;
	const yearOfEra = adjustedYear - era * 400n;
	const shiftedMonth = month + (month > 2n ? -3n : 9n);
	const dayOfYear = (153n * shiftedMonth + 2n) / 5n + day - 1n;
	const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
	return era * 146_097n + dayOfEra - 719_468n;
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function parseInstant(value: Date | string, field: string): ParsedInstant {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
		return {
			seconds: BigInt(Math.floor(value.getTime() / 1000)),
			fraction: `${value.getMilliseconds()}`.padStart(3, "0"),
		};
	}
	const match = RFC3339.exec(value);
	if (!match) throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] =
		match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const monthLengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		year === 0 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > monthLengths[month - 1]! ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
	}
	let offset = 0n;
	if (zone !== "Z") {
		const zoneText = zone!;
		const offsetHours = Number(zoneText.slice(1, 3));
		const offsetMinutes = Number(zoneText.slice(4, 6));
		if (offsetHours > 23 || offsetMinutes > 59 || zoneText === "-00:00") {
			throw new TypeError(`${field} must be a valid RFC 3339 timestamp`);
		}
		offset = BigInt(offsetHours * 3600 + offsetMinutes * 60) * (zoneText[0] === "+" ? 1n : -1n);
	}
	return {
		seconds:
			daysFromCivil(BigInt(year), BigInt(month), BigInt(day)) * 86_400n +
			BigInt(hour * 3600 + minute * 60 + second) -
			offset,
		fraction,
	};
}

export function compareInstants(left: ParsedInstant, right: ParsedInstant): number {
	if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
	const length = Math.max(left.fraction.length, right.fraction.length);
	for (let index = 0; index < length; index++) {
		const leftDigit = left.fraction[index] ?? "0";
		const rightDigit = right.fraction[index] ?? "0";
		if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
	}
	return 0;
}
