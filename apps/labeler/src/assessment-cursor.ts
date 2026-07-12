/**
 * Labeler-local opaque cursor for `listAssessments` pagination (contracts
 * line 220). Distinct from the aggregator's `cursor.ts` — different package,
 * different shape (keyset on `created_at`/`id` here, `version_sort`/`offset`
 * there) — so this is intentionally not shared.
 *
 * A *provided* cursor that fails to decode throws `InvalidCursorError`,
 * which the handler converts to a 400 `InvalidCursor`. It never silently
 * falls back to page one: a client whose filters changed between requests
 * (or whose cursor was mangled) needs to know its cursor is stale, not
 * quietly restart pagination from the top.
 */

const CURSOR_VERSION = 1;

export class InvalidCursorError extends Error {
	override readonly name = "InvalidCursorError";
}

export interface AssessmentCursor {
	createdAt: string;
	id: string;
}

/** Stable hash of the effective filter set (src is always the deployment's
 * own DID, so it's not part of the key). A cursor decoded against a
 * different filter set is rejected rather than silently repaged. */
export async function computeFilterHash(filters: {
	uri?: string;
	cid?: string;
	state?: string;
}): Promise<string> {
	const normalized = JSON.stringify({
		uri: filters.uri ?? null,
		cid: filters.cid ?? null,
		state: filters.state ?? null,
	});
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeCursor(last: AssessmentCursor, filterHash: string): string {
	return base64UrlEncode(
		JSON.stringify({ v: CURSOR_VERSION, createdAt: last.createdAt, id: last.id, filterHash }),
	);
}

export function decodeCursor(
	cursor: string | undefined,
	currentFilterHash: string,
): AssessmentCursor | null {
	if (cursor === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(base64UrlDecode(cursor));
	} catch {
		throw new InvalidCursorError("cursor is not valid base64url-encoded JSON");
	}
	if (!isPlainObject(parsed)) throw new InvalidCursorError("cursor must decode to a JSON object");
	if (parsed.v !== CURSOR_VERSION) throw new InvalidCursorError("unsupported cursor version");
	const { createdAt, id, filterHash } = parsed;
	if (typeof createdAt !== "string" || typeof id !== "string" || typeof filterHash !== "string")
		throw new InvalidCursorError("cursor is missing required fields");
	if (!Number.isFinite(Date.parse(createdAt)))
		throw new InvalidCursorError("cursor createdAt is not a valid timestamp");
	if (filterHash !== currentFilterHash)
		throw new InvalidCursorError("cursor does not match the request's filters");
	return { createdAt, id };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	for (const byte of bytes) str += String.fromCharCode(byte);
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
