import { ApiError } from "./errors.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 2048;
const MAX_CURSOR_PART_LENGTH = 512;
const BASE64_PADDING_PATTERN = /=+$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface PaginationCursor {
	version: 1;
	orderValue: string;
	id: string;
}

export interface Pagination {
	limit: number;
	cursor?: PaginationCursor;
}

function toBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(BASE64_PADDING_PATTERN, "");
}

function fromBase64Url(value: string): string {
	if (!BASE64_URL_PATTERN.test(value) || value.length > MAX_CURSOR_LENGTH) {
		throw new ApiError("INVALID_CURSOR", 400, "Invalid pagination cursor");
	}
	const padded = value
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

export function encodeCursor(orderValue: string, id: string): string {
	if (
		orderValue.length === 0 ||
		orderValue.length > MAX_CURSOR_PART_LENGTH ||
		id.length === 0 ||
		id.length > MAX_CURSOR_PART_LENGTH
	) {
		throw new ApiError("INVALID_CURSOR", 400, "Invalid pagination cursor");
	}
	const cursor = toBase64Url(JSON.stringify([1, orderValue, id]));
	if (cursor.length > MAX_CURSOR_LENGTH) {
		throw new ApiError("INVALID_CURSOR", 400, "Invalid pagination cursor");
	}
	return cursor;
}

export function decodeCursor(value: string): PaginationCursor {
	try {
		const parsed: unknown = JSON.parse(fromBase64Url(value));
		if (
			!Array.isArray(parsed) ||
			parsed.length !== 3 ||
			parsed[0] !== 1 ||
			typeof parsed[1] !== "string" ||
			parsed[1].length === 0 ||
			parsed[1].length > MAX_CURSOR_PART_LENGTH ||
			typeof parsed[2] !== "string" ||
			parsed[2].length === 0 ||
			parsed[2].length > MAX_CURSOR_PART_LENGTH
		) {
			throw new Error("invalid cursor shape");
		}
		return { version: 1, orderValue: parsed[1], id: parsed[2] };
	} catch {
		throw new ApiError("INVALID_CURSOR", 400, "Invalid pagination cursor");
	}
}

export function parsePagination(searchParams: URLSearchParams): Pagination {
	const rawLimit = searchParams.get("limit");
	const parsedLimit = rawLimit === null ? DEFAULT_LIMIT : Number.parseInt(rawLimit, 10);
	const limit = Number.isFinite(parsedLimit)
		? Math.min(MAX_LIMIT, Math.max(1, parsedLimit))
		: DEFAULT_LIMIT;
	const rawCursor = searchParams.get("cursor");
	return rawCursor ? { limit, cursor: decodeCursor(rawCursor) } : { limit };
}
