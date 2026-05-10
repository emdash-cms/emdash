/**
 * Cursor encoding for paginated XRPC responses.
 *
 * Cursors are opaque base64url strings to clients; internally they encode
 * a small JSON object specific to the endpoint's ORDER BY clause. We use
 * different shapes for different endpoints (list cursors carry sort
 * keys; offset cursors carry an integer) — keep each endpoint's encoder
 * paired with its decoder.
 *
 * `decode*` functions accept `undefined` for "no cursor" and never throw.
 * A malformed cursor (forged, base64 garbage, or carrying an unexpected
 * shape) returns `null`, which callers treat as "start from the
 * beginning". Throwing would let a client attacker DOS by sending bad
 * cursors; silently restarting is safer than 400ing.
 */

import { isPlainObject } from "../../utils.js";

interface ListCursor {
	versionSort: string;
	version: string;
}

export function encodeListCursor(cursor: ListCursor): string {
	return base64UrlEncode(JSON.stringify(cursor));
}

export function decodeListCursor(raw: string | undefined): ListCursor | null {
	if (raw === undefined) return null;
	try {
		const parsed: unknown = JSON.parse(base64UrlDecode(raw));
		if (!isPlainObject(parsed)) return null;
		const versionSort = parsed["versionSort"];
		const version = parsed["version"];
		if (typeof versionSort !== "string" || typeof version !== "string") return null;
		return { versionSort, version };
	} catch {
		return null;
	}
}

interface OffsetCursor {
	offset: number;
}

export function encodeOffsetCursor(cursor: OffsetCursor): string {
	return base64UrlEncode(JSON.stringify(cursor));
}

export function decodeOffsetCursor(raw: string | undefined): OffsetCursor | null {
	if (raw === undefined) return null;
	try {
		const parsed: unknown = JSON.parse(base64UrlDecode(raw));
		if (!isPlainObject(parsed)) return null;
		const offset = parsed["offset"];
		if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return null;
		return { offset };
	} catch {
		return null;
	}
}

const BASE64URL_PLUS = /\+/g;
const BASE64URL_SLASH = /\//g;
const BASE64URL_TRAILING_EQUALS = /=+$/;
const BASE64URL_DASH = /-/g;
const BASE64URL_UNDERSCORE = /_/g;

function base64UrlEncode(value: string): string {
	// btoa needs latin-1; encode UTF-8 first via TextEncoder.
	const bytes = new TextEncoder().encode(value);
	let str = "";
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte === undefined) continue;
		str += String.fromCharCode(byte);
	}
	return btoa(str)
		.replace(BASE64URL_PLUS, "-")
		.replace(BASE64URL_SLASH, "_")
		.replace(BASE64URL_TRAILING_EQUALS, "");
}

function base64UrlDecode(value: string): string {
	const padded = value
		.replace(BASE64URL_DASH, "+")
		.replace(BASE64URL_UNDERSCORE, "/")
		.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}
