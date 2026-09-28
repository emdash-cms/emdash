/**
 * Storage-key references inside records.
 *
 * Origin storage keys are deployment state and never appear in a package.
 * The exporter replaces every reference to a local media object's storage key
 * with the placeholder `emdash-media:<mediaId>`; the importer replaces each
 * placeholder with the key it stored that media row's bytes under on the
 * target; verification turns target keys back into placeholders.
 *
 * The walker is schema-agnostic. It visits every string of a record except
 * the record's identity properties ({@link identityProperties}), including
 * strings that hold JSON (image and file field values) which it parses,
 * rewrites, and re-serializes with `JSON.stringify` only when something
 * changed. It recognizes:
 *
 * - `/_emdash/api/media/file/<key>` anywhere in a string, relative or behind
 *   any origin; only the key segment is replaced, unless the caller asks to
 *   relativize, in which case an absolute URL's scheme and host are dropped
 *   too so the importer resolves it against the target;
 * - `meta.storageKey` of a media value object;
 * - a local media value whose `id` is a storage key (a value stored without
 *   `meta.storageKey`);
 * - a bare storage key as the whole value of `seo.seoImage` or of a top-level
 *   entry field.
 *
 * Text that already reads `emdash-media:` in an origin string is escaped as
 * `emdash-media::` on export and unescaped on import, so every unescaped
 * `emdash-media:` in a package is a placeholder and literal text round-trips
 * exactly. Import and escaping work on each record string as text; a string
 * holding JSON is re-serialized only when a storage key inside it was
 * rewritten.
 *
 * A key that equals some media row's id is treated as that id (ids are
 * portable) and left alone. When several media rows share a key, the smallest
 * id wins. Keys that are not in the origin `media` table are left untouched
 * and reported as `unknown_storage_key` warnings.
 */

import { measureJsonDepth } from "./canonical.js";
import { compareIds, identityProperties, type RecordKind } from "./kinds.js";
import { TRANSFER_LIMITS } from "./limits.js";

export const MEDIA_PLACEHOLDER_PREFIX = "emdash-media:";
export const MEDIA_FILE_PATH = "/_emdash/api/media/file/";

const PLACEHOLDER_ID_PATTERN = /^[0-9A-Za-z_-]{1,128}$/;
const PLACEHOLDER_ESCAPE = `${MEDIA_PLACEHOLDER_PREFIX}:`;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const PERCENT_ESCAPE = /%[0-9A-F]{2}/g;
const HARD_SEGMENT_END = /[?#"'<>`\r\n\t]/g;
const SOFT_SEGMENT_END = /[\s)\]]/g;
const STORAGE_KEY_CHARS = /^[A-Za-z0-9._-]+$/;
const KEY_TOKEN_PATTERN = /[A-Za-z0-9._-]+/g;
const MAX_ISSUES_PER_RECORD = 20;
/** Characters before a media file path searched for the URL's scheme and host. */
const ORIGIN_WINDOW = 2048;

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}

function isLetter(code: number): boolean {
	const lower = code | 0x20;
	return lower >= 97 && lower <= 122;
}

/** `[A-Za-z0-9.-]` */
function isHostChar(code: number): boolean {
	return isLetter(code) || isDigit(code) || code === 46 || code === 45;
}

/** `[A-Za-z0-9+.-]` */
function isSchemeChar(code: number): boolean {
	return isHostChar(code) || code === 43;
}

/** `[0-9A-Za-z_-]` */
function isPlaceholderIdChar(code: number): boolean {
	return isLetter(code) || isDigit(code) || code === 95 || code === 45;
}

/**
 * One `emdash-media:` in a package string: group 1 is set for an escape
 * (`emdash-media::`, standing for the text `emdash-media:`), group 2 holds
 * the media id of a placeholder, and neither is set for a malformed one.
 */
export const PLACEHOLDER_TOKEN = /emdash-media:(?:(:)|([0-9A-Za-z_-]{1,128}))?/g;

/** Escape every `emdash-media:` already in `value` (see {@link PLACEHOLDER_TOKEN}). */
export function escapePlaceholderText(value: string): string {
	return value.includes(MEDIA_PLACEHOLDER_PREFIX)
		? value.replaceAll(MEDIA_PLACEHOLDER_PREFIX, PLACEHOLDER_ESCAPE)
		: value;
}

export function canUsePlaceholder(mediaId: string): boolean {
	return PLACEHOLDER_ID_PATTERN.test(mediaId);
}

export function mediaPlaceholder(mediaId: string): string {
	if (!canUsePlaceholder(mediaId)) {
		throw new TypeError("Media id cannot be used in a media placeholder");
	}
	return `${MEDIA_PLACEHOLDER_PREFIX}${mediaId}`;
}

/** The media id when `value` is exactly one placeholder, else null. */
export function parseMediaPlaceholder(value: string): string | null {
	if (!value.startsWith(MEDIA_PLACEHOLDER_PREFIX)) return null;
	const id = value.slice(MEDIA_PLACEHOLDER_PREFIX.length);
	return PLACEHOLDER_ID_PATTERN.test(id) ? id : null;
}

export interface MediaKeyIndex {
	/** Storage key → media id (smallest id when keys are shared). */
	readonly keyToMediaId: ReadonlyMap<string, string>;
	/** Every media id; a key equal to one of these is treated as an id. */
	readonly mediaIds: ReadonlySet<string>;
}

export function buildMediaKeyIndex(
	rows: Iterable<{ id: string; storageKey: string }>,
): MediaKeyIndex {
	const keyToMediaId = new Map<string, string>();
	const mediaIds = new Set<string>();
	for (const row of rows) {
		mediaIds.add(row.id);
		const existing = keyToMediaId.get(row.storageKey);
		if (existing === undefined || compareIds(row.id, existing) < 0) {
			keyToMediaId.set(row.storageKey, row.id);
		}
	}
	return { keyToMediaId, mediaIds };
}

export type MediaRefIssueCode =
	/** A storage-key reference whose key is not in the origin media table. */
	| "unknown_storage_key"
	/** An import placeholder names a media id with no target key. */
	| "unresolved_placeholder"
	/** A referenced media id cannot be written as a placeholder. */
	| "media_id_not_placeholderable";

export interface MediaRefIssue {
	code: MediaRefIssueCode;
	/** Path inside the record, e.g. `fields.content[2].asset.url`. */
	path: string;
	/** The unknown key (export/verify) or the media id (import). */
	value: string;
}

export type MediaRefMode = "export" | "import" | "verify";

/**
 * - `export`: `keys` indexes the origin media table. With `relativize`, an
 *   absolute URL to the media file route whose key is known loses its scheme
 *   and host (declared as `media_url_relativized`).
 * - `verify`: `keys` indexes the target media table with ids mapped back to
 *   portable media ids, so the result compares equal to the package record.
 *   `relativize` predicts the exporter's relativization.
 * - `import`: `mediaIdToKey` maps portable media ids to target storage keys.
 */
export type RewriteMediaRefsOptions =
	| { mode: "export" | "verify"; keys: MediaKeyIndex; relativize?: boolean }
	| { mode: "import"; mediaIdToKey: ReadonlyMap<string, string> };

export interface RewriteMediaRefsResult<T> {
	value: T;
	changed: boolean;
	/** Media ids referenced through storage keys or placeholders (sorted, unique). */
	mediaIds: string[];
	/** Non-fatal issues (at most 20 per record). */
	warnings: MediaRefIssue[];
	/** Fatal issues: the record must not be exported, imported, or verified as is. */
	errors: MediaRefIssue[];
	/** Absolute media file URLs made relative (with `relativize`). */
	relativized: number;
}

interface WalkContext {
	options: RewriteMediaRefsOptions;
	kind: RecordKind;
	mediaIds: Set<string>;
	warnings: MediaRefIssue[];
	errors: MediaRefIssue[];
	relativized: number;
	/** Storage keys replaced with placeholders so far. */
	placeholders: number;
}

/**
 * Rewrite the storage-key references in one record. Returns the input object
 * itself when nothing changed; never mutates it.
 */
export function rewriteMediaRefs<T extends { kind: RecordKind }>(
	record: T,
	options: RewriteMediaRefsOptions,
): RewriteMediaRefsResult<T> {
	const context: WalkContext = {
		options,
		kind: record.kind,
		mediaIds: new Set(),
		warnings: [],
		errors: [],
		relativized: 0,
		placeholders: 0,
	};
	const skip = identityProperties(record.kind);
	const changes: Record<string, unknown> = {};
	let changed = false;
	for (const [property, value] of Object.entries(record)) {
		if (skip.has(property)) continue;
		const next = walk(value, context, property, [property]);
		if (next !== value) {
			changes[property] = next;
			changed = true;
		}
	}
	return {
		value: changed ? { ...record, ...changes } : record,
		changed,
		mediaIds: [...context.mediaIds].toSorted(compareIds),
		warnings: context.warnings,
		errors: context.errors,
		relativized: context.relativized,
	};
}

function report(list: MediaRefIssue[], issue: MediaRefIssue): void {
	if (list.length < MAX_ISSUES_PER_RECORD) list.push(issue);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBareKeyPosition(kind: RecordKind, segments: readonly string[]): boolean {
	if (kind === "seo") return segments.length === 1 && segments[0] === "seoImage";
	if (kind === "entry") return segments.length === 2 && segments[0] === "fields";
	return false;
}

function walk(value: unknown, context: WalkContext, path: string, segments: string[]): unknown {
	if (typeof value === "string") return rewriteString(value, context, path, segments);
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item, index) => {
			const rewritten = walk(item, context, `${path}[${index}]`, [...segments, String(index)]);
			if (rewritten !== item) changed = true;
			return rewritten;
		});
		return changed ? next : value;
	}
	if (isPlainObject(value)) return rewriteObject(value, context, path, segments);
	return value;
}

function rewriteObject(
	value: Record<string, unknown>,
	context: WalkContext,
	path: string,
	segments: string[],
): Record<string, unknown> {
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		const rewritten = walk(child, context, `${path}.${key}`, [...segments, key]);
		if (rewritten !== child) changed = true;
		next[key] = rewritten;
	}

	if (context.options.mode !== "import") {
		const { keys } = context.options;
		const provider = value.provider;
		const isLocal = provider === undefined || provider === null || provider === "local";

		const meta = value.meta;
		if (isLocal && isPlainObject(meta) && typeof meta.storageKey === "string") {
			const storageKey = meta.storageKey;
			const placeholder = placeholderForKey(storageKey, keys, context, `${path}.meta.storageKey`);
			if (placeholder !== null) {
				const nextMeta = isPlainObject(next.meta) ? next.meta : meta;
				next.meta = { ...nextMeta, storageKey: placeholder };
				changed = true;
			} else if (!keys.mediaIds.has(storageKey)) {
				report(context.warnings, {
					code: "unknown_storage_key",
					path: `${path}.meta.storageKey`,
					value: storageKey,
				});
			}
		}

		const id = value.id;
		if (isLocal && typeof id === "string" && !keys.mediaIds.has(id)) {
			const placeholder = placeholderForKey(id, keys, context, `${path}.id`);
			if (placeholder !== null) {
				next.id = placeholder;
				changed = true;
			}
		}
	}

	return changed ? next : value;
}

/** Placeholder for a known storage key, or null when `key` is not a known key. */
function placeholderForKey(
	key: string,
	keys: MediaKeyIndex,
	context: WalkContext,
	path: string,
): string | null {
	if (keys.mediaIds.has(key)) return null;
	const mediaId = keys.keyToMediaId.get(key);
	if (mediaId === undefined) return null;
	if (!canUsePlaceholder(mediaId)) {
		report(context.errors, { code: "media_id_not_placeholderable", path, value: mediaId });
		return null;
	}
	context.mediaIds.add(mediaId);
	context.placeholders++;
	return `${MEDIA_PLACEHOLDER_PREFIX}${mediaId}`;
}

function rewriteString(
	value: string,
	context: WalkContext,
	path: string,
	segments: string[],
): string {
	if (context.options.mode === "import") {
		return resolvePlaceholders(value, context.options.mediaIdToKey, context, path);
	}
	const { keys } = context.options;

	if (isBareKeyPosition(context.kind, segments)) {
		const placeholder = placeholderForKey(value, keys, context, path);
		if (placeholder !== null) return placeholder;
	}

	const trimmed = value.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		const parsed = parseEmbeddedJson(value);
		if (parsed !== undefined) {
			const placeholders = context.placeholders;
			const rewritten = walk(parsed, context, path, segments);
			// Escaping the text rather than re-serializing keeps the JSON byte for byte.
			return context.placeholders === placeholders
				? escapePlaceholderText(value)
				: JSON.stringify(rewritten);
		}
	}

	const escaped = escapePlaceholderText(value);
	if (!escaped.includes(MEDIA_FILE_PATH)) return escaped;
	return rewriteMediaFileUrls(escaped, keys, context, path, context.options.relativize === true);
}

function decodePercent(segment: string): string | null {
	if (!segment.includes("%")) return null;
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

/**
 * Index of the first match of the global `pattern` at or after a start, for
 * starts that never decrease: a match found earlier is reused while it is
 * still ahead, so all calls together scan `value` once.
 */
function endFinder(value: string, pattern: RegExp): (start: number) => number {
	let found = -1;
	return (start) => {
		if (found >= start) return found;
		pattern.lastIndex = start;
		const match = pattern.exec(value);
		found = match ? match.index : value.length;
		return found;
	};
}

/**
 * Start of the `scheme://host[:port]` or `//host[:port]` that ends at `at`,
 * or -1. Only `value[from, at)` is examined; the scheme is the longest one
 * that fits there.
 */
function originStart(value: string, from: number, at: number): number {
	const floor = Math.max(from, at - ORIGIN_WINDOW);
	const is = (test: (code: number) => boolean, index: number) =>
		index >= floor && test(value.charCodeAt(index));
	let end = at;
	let digits = end;
	while (is(isDigit, digits - 1)) digits--;
	if (digits < end && value[digits - 1] === ":" && digits - 1 >= floor) end = digits - 1;
	let host = end;
	while (is(isHostChar, host - 1)) host--;
	if (host === end || host - 2 < floor || value[host - 1] !== "/" || value[host - 2] !== "/") {
		return -1;
	}
	const slashes = host - 2;
	if (slashes - 1 < floor || value[slashes - 1] !== ":") return slashes;
	let scheme = slashes - 1;
	while (is(isSchemeChar, scheme - 1)) scheme--;
	for (let index = scheme; index < slashes - 1; index++) {
		if (isLetter(value.charCodeAt(index))) return index;
	}
	return slashes;
}

/**
 * Replace the key segment of every `/_emdash/api/media/file/<key>` in
 * `value`. The segment runs to the first `?#"'<>`, backtick, or line break.
 * The longest prefix of the segment that is a known storage key, raw or
 * percent-decoded, is replaced; this covers keys with spaces, parentheses,
 * `+`, or non-ASCII characters, percent-encoded URLs, and keys followed by
 * punctuation. A segment whose prefix up to whitespace, `)` or `]` is neither
 * a key nor a media id is reported as `unknown_storage_key`. With
 * `relativize`, a replaced URL also loses the scheme and host before it.
 */
function rewriteMediaFileUrls(
	value: string,
	keys: MediaKeyIndex,
	context: WalkContext,
	path: string,
	relativize: boolean,
): string {
	const maxRawLength = maxKeyLength(keys) * MAX_ENCODED_CHARS_PER_CHAR;
	const hardEnd = endFinder(value, HARD_SEGMENT_END);
	const softEnd = endFinder(value, SOFT_SEGMENT_END);
	let output = "";
	let cursor = 0;
	let at = value.indexOf(MEDIA_FILE_PATH);
	while (at !== -1) {
		const start = at + MEDIA_FILE_PATH.length;
		const remainder = value.slice(start, Math.min(hardEnd(start), start + maxRawLength));
		const match = longestKeyPrefix(remainder, keys);
		const placeholder = match ? placeholderForKey(match.key, keys, context, path) : null;

		if (match && placeholder !== null) {
			const origin = relativize ? originStart(value, cursor, at) : -1;
			if (origin !== -1) context.relativized++;
			output += value.slice(cursor, origin === -1 ? at : origin);
			output += MEDIA_FILE_PATH + placeholder;
			cursor = start + match.length;
		} else {
			output += value.slice(cursor, start);
			cursor = start;
		}
		if (!match && context.warnings.length < MAX_ISSUES_PER_RECORD) {
			const end = Math.min(hardEnd(start), softEnd(start), start + MAX_MEDIA_ID_SEGMENT);
			const segment = value.slice(start, end);
			const decoded = decodePercent(segment);
			if (
				segment.length > 0 &&
				!keys.mediaIds.has(segment) &&
				!(decoded !== null && keys.mediaIds.has(decoded))
			) {
				report(context.warnings, { code: "unknown_storage_key", path, value: segment });
			}
		}
		at = value.indexOf(MEDIA_FILE_PATH, Math.max(cursor, start));
	}
	return output + value.slice(cursor);
}

function longestKeyPrefix(
	remainder: string,
	keys: MediaKeyIndex,
): { key: string; length: number } | null {
	const lengths = keyLengths(keys);
	const decodedEnds = decodedKeyLengthEnds(remainder, keys);
	const candidates =
		decodedEnds.size === 0
			? sortedKeyLengths(keys)
			: [...new Set([...lengths, ...decodedEnds])].toSorted((a, b) => b - a);
	for (const length of candidates) {
		if (length > remainder.length || length === 0) continue;
		if (lengths.has(length)) {
			const prefix = remainder.slice(0, length);
			if (keys.keyToMediaId.has(prefix) && !keys.mediaIds.has(prefix)) {
				return { key: prefix, length };
			}
		}
		if (decodedEnds.has(length)) {
			const decoded = decodePercent(remainder.slice(0, length));
			if (decoded !== null && keys.keyToMediaId.has(decoded) && !keys.mediaIds.has(decoded)) {
				return { key: decoded, length };
			}
		}
	}
	return null;
}

function hexDigit(code: number): number {
	if (code >= 48 && code <= 57) return code - 48;
	const lower = code | 0x20;
	return lower >= 97 && lower <= 102 ? lower - 87 : -1;
}

/**
 * Lengths of the prefixes of `remainder` that contain a percent escape and
 * would percent-decode to a string as long as some key, so only those are
 * decoded. Stops at the first escape that cannot start or continue a UTF-8
 * sequence, since no longer prefix decodes, and past the longest key.
 */
function decodedKeyLengthEnds(remainder: string, keys: MediaKeyIndex): Set<number> {
	const lengths = keyLengths(keys);
	const ends = new Set<number>();
	let index = remainder.indexOf("%");
	if (index === -1) return ends;
	const longest = sortedKeyLengths(keys)[0] ?? 0;
	let decoded = index;
	let pending = 0;
	let units = 0;
	while (index < remainder.length && decoded <= longest) {
		if (remainder[index] === "%") {
			const high = hexDigit(remainder.charCodeAt(index + 1));
			const low = hexDigit(remainder.charCodeAt(index + 2));
			if (high === -1 || low === -1) break;
			const byte = high * 16 + low;
			index += 3;
			if (pending > 0) {
				if ((byte & 0xc0) !== 0x80) break;
				pending--;
				if (pending === 0) decoded += units;
			} else if (byte < 0x80) {
				decoded++;
			} else if ((byte & 0xe0) === 0xc0) {
				pending = 1;
				units = 1;
			} else if ((byte & 0xf0) === 0xe0) {
				pending = 2;
				units = 1;
			} else if ((byte & 0xf8) === 0xf0) {
				pending = 3;
				units = 2;
			} else {
				break;
			}
		} else {
			if (pending > 0) break;
			decoded++;
			index++;
		}
		if (pending === 0 && lengths.has(decoded)) ends.add(index);
	}
	return ends;
}

/** A UTF-8 character percent-encodes to at most 12 characters (`%XX` × 4). */
const MAX_ENCODED_CHARS_PER_CHAR = 12;

/** Longest media file URL segment that can still spell a media id. */
const MAX_MEDIA_ID_SEGMENT = TRANSFER_LIMITS.idLength * MAX_ENCODED_CHARS_PER_CHAR;

const keyLengthsCache = new WeakMap<MediaKeyIndex, ReadonlySet<number>>();

function keyLengths(keys: MediaKeyIndex): ReadonlySet<number> {
	let lengths = keyLengthsCache.get(keys);
	if (lengths === undefined) {
		lengths = new Set(Array.from(keys.keyToMediaId.keys(), (key) => key.length));
		keyLengthsCache.set(keys, lengths);
	}
	return lengths;
}

const sortedKeyLengthsCache = new WeakMap<MediaKeyIndex, readonly number[]>();

/** Distinct key lengths, longest first. */
function sortedKeyLengths(keys: MediaKeyIndex): readonly number[] {
	let sorted = sortedKeyLengthsCache.get(keys);
	if (sorted === undefined) {
		sorted = [...keyLengths(keys)].toSorted((a, b) => b - a);
		sortedKeyLengthsCache.set(keys, sorted);
	}
	return sorted;
}

function maxKeyLength(keys: MediaKeyIndex): number {
	return sortedKeyLengths(keys)[0] ?? 0;
}

function parseEmbeddedJson(value: string): unknown {
	if (measureJsonDepth(value, TRANSFER_LIMITS.jsonDepth) > TRANSFER_LIMITS.jsonDepth) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null ? parsed : undefined;
	} catch {
		return undefined;
	}
}

const PLACEHOLDER_FILE_PATH = `${MEDIA_FILE_PATH}${MEDIA_PLACEHOLDER_PREFIX}`;

/**
 * Drop the scheme and host before every placeholder media file URL. A
 * placeholder names media on the site that holds the package's data, so on
 * import its URL is the target's own relative media file route. Verification
 * applies the same normalization to package records before comparing.
 */
export function relativizePlaceholderUrls(value: string): string {
	let output = "";
	let cursor = 0;
	let at = value.indexOf(PLACEHOLDER_FILE_PATH);
	while (at !== -1) {
		const next = at + PLACEHOLDER_FILE_PATH.length;
		if (isPlaceholderIdChar(value.charCodeAt(next))) {
			const origin = originStart(value, cursor, at);
			if (origin !== -1) {
				output += value.slice(cursor, origin);
				cursor = at;
			}
		}
		at = value.indexOf(PLACEHOLDER_FILE_PATH, next);
	}
	return cursor === 0 ? value : output + value.slice(cursor);
}

function resolvePlaceholders(
	value: string,
	mediaIdToKey: ReadonlyMap<string, string>,
	context: WalkContext,
	path: string,
): string {
	if (!value.includes(MEDIA_PLACEHOLDER_PREFIX)) return value;
	return relativizePlaceholderUrls(value).replace(
		PLACEHOLDER_TOKEN,
		(match, escape: string | undefined, mediaId: string | undefined) => {
			if (escape !== undefined) return MEDIA_PLACEHOLDER_PREFIX;
			if (mediaId === undefined) return match;
			const key = mediaIdToKey.get(mediaId);
			if (key === undefined) {
				report(context.errors, { code: "unresolved_placeholder", path, value: mediaId });
				return match;
			}
			context.mediaIds.add(mediaId);
			return key;
		},
	);
}

/**
 * Keys suitable for {@link scanForKeys}: every storage key except those equal
 * to a media id (those are indistinguishable from the portable id).
 */
export function scannableKeys(keys: MediaKeyIndex): Set<string> {
	const result = new Set<string>();
	for (const key of keys.keyToMediaId.keys()) {
		if (!keys.mediaIds.has(key)) result.add(key);
	}
	return result;
}

/**
 * Walker-independent check: every key from `keys` that occurs anywhere in
 * `text` as a substring, raw, percent-encoded (either hex case), or with
 * JSON string escaping (sorted, unique). Exporter self-validation runs it
 * over every record line and fails the export if anything is found.
 */
export function scanForKeys(text: string, keys: ReadonlySet<string>): string[] {
	if (keys.size === 0 || text.length === 0) return [];
	const found = new Set<string>();
	const lengths = new Set<number>();
	const irregular: string[] = [];
	for (const key of keys) {
		if (STORAGE_KEY_CHARS.test(key)) lengths.add(key.length);
		else if (key.length > 0) irregular.push(key);
	}
	const sortedLengths = [...lengths].toSorted((a, b) => a - b);
	const texts = text.includes("%") ? [text, decodePercentRuns(text)] : [text];
	for (const candidateText of texts) {
		for (const match of candidateText.matchAll(KEY_TOKEN_PATTERN)) {
			const token = match[0];
			for (const length of sortedLengths) {
				if (length > token.length) break;
				for (let start = 0; start + length <= token.length; start++) {
					const candidate = token.slice(start, start + length);
					if (keys.has(candidate)) found.add(candidate);
				}
			}
		}
		for (const key of irregular) {
			if (keyForms(key).some((form) => candidateText.includes(form))) found.add(key);
		}
	}
	return [...found].toSorted(compareIds);
}

function keyForms(key: string): string[] {
	const encoded = encodeURIComponent(key);
	return [
		...new Set([
			key,
			JSON.stringify(key).slice(1, -1),
			encoded,
			encoded.replace(PERCENT_ESCAPE, (escape) => escape.toLowerCase()),
			encodeURI(key),
		]),
	];
}

/** Decode each run of `%XX` escapes that forms valid UTF-8; leave the rest. */
function decodePercentRuns(text: string): string {
	return text.replace(PERCENT_RUN, (run) => {
		try {
			return decodeURIComponent(run);
		} catch {
			return run;
		}
	});
}
