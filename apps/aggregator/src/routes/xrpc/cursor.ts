/**
 * Cursor encoding for paginated XRPC responses.
 *
 * Cursors are opaque base64url strings to clients; internally they encode
 * a small JSON object specific to the endpoint's ORDER BY clause. We use
 * different shapes for different endpoints (list cursors carry sort
 * keys; offset cursors carry an integer).
 *
 * Decode discipline: an *absent* cursor (`undefined`) means "first page".
 * A *provided* cursor that fails to decode throws `InvalidCursorError`,
 * which handlers translate into a 400 InvalidRequest. Earlier drafts
 * silently restarted on bad cursors to defend against DOS via forged
 * cursors, but that policy lets a legitimate client (with a corrupted
 * cursor from URL-encoding mishaps, mid-rollout schema changes, etc.)
 * loop forever re-fetching page 1 thinking they're paginating. The DOS
 * argument doesn't apply because the workload is bounded by `limit`
 * regardless. Throw loud, fail fast.
 *
 * Offset cursors additionally cap `offset` to `MAX_OFFSET` so a forged
 * cursor with a wildly large offset can't trigger an arbitrarily deep
 * SQL scan. Real clients never paginate that deep.
 */

import { isPlainObject } from "../../utils.js";

/** Throw when a *provided* cursor fails to decode. Handler catches and
 * converts to 400 InvalidRequest. */
export class InvalidCursorError extends Error {
	override readonly name = "InvalidCursorError";
}

interface ListCursor {
	versionSort: string;
	version: string;
}

export function encodeListCursor(cursor: ListCursor): string {
	return base64UrlEncode(JSON.stringify(cursor));
}

export function decodeListCursor(raw: string | undefined): ListCursor | null {
	if (raw === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(base64UrlDecode(raw));
	} catch {
		throw new InvalidCursorError("cursor is not a valid base64url-encoded JSON object");
	}
	if (!isPlainObject(parsed)) {
		throw new InvalidCursorError("cursor must decode to a JSON object");
	}
	const versionSort = parsed["versionSort"];
	const version = parsed["version"];
	if (typeof versionSort !== "string" || typeof version !== "string") {
		throw new InvalidCursorError("cursor must carry string `versionSort` and `version` fields");
	}
	return { versionSort, version };
}

interface OffsetCursor {
	offset: number;
}

/** Cap on offset values accepted from a client cursor. Real pagination
 * never reaches this depth — at the lexicon's `limit: 100` cap that's
 * 100 pages of 100 results = 10k items; defaulting to `limit: 25` makes
 * it 400 pages. Past that, a forged cursor is the more likely
 * explanation than a legitimate client. */
const MAX_OFFSET = 10_000;

export function encodeOffsetCursor(cursor: OffsetCursor): string {
	return base64UrlEncode(JSON.stringify(cursor));
}

export function decodeOffsetCursor(raw: string | undefined): OffsetCursor | null {
	if (raw === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(base64UrlDecode(raw));
	} catch {
		throw new InvalidCursorError("cursor is not a valid base64url-encoded JSON object");
	}
	if (!isPlainObject(parsed)) {
		throw new InvalidCursorError("cursor must decode to a JSON object");
	}
	const offset = parsed["offset"];
	if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
		throw new InvalidCursorError("cursor `offset` must be a non-negative integer");
	}
	if (offset > MAX_OFFSET) {
		throw new InvalidCursorError(`cursor offset exceeds maximum (${MAX_OFFSET})`);
	}
	return { offset };
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
