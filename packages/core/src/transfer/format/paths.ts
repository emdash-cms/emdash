/**
 * Package file paths.
 *
 * A package contains exactly these files, and nothing else:
 *
 * ```
 * manifest.json
 * index/<seq>.ndjson                file index chunks, listed in the manifest
 * records/<kind>/<seq>.ndjson       record chunks, listed in the index
 * media/<sha256-hex>                raw media bytes, listed in the index
 * ```
 *
 * `seq` is a zero-padded six-digit number starting at `000000` with no gaps.
 * Paths are case-sensitive, relative, and never contain `.`/`..` segments,
 * backslashes, or empty segments; anything that does not match is rejected.
 */

import { isRecordKind, type RecordKind } from "./kinds.js";

export const MANIFEST_PATH = "manifest.json";

const SEQ_DIGITS = 6;
const MAX_SEQ = 10 ** SEQ_DIGITS - 1;

const INDEX_PATH_PATTERN = /^index\/(\d{6})\.ndjson$/;
const RECORD_PATH_PATTERN = /^records\/([a-z_]+)\/(\d{6})\.ndjson$/;
const MEDIA_PATH_PATTERN = /^media\/([0-9a-f]{64})$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type PackagePath =
	| { type: "manifest"; path: typeof MANIFEST_PATH }
	| { type: "index"; path: string; seq: number }
	| { type: "records"; path: string; kind: RecordKind; seq: number }
	| { type: "media"; path: string; sha256: string };

export function parsePackagePath(path: string): PackagePath | null {
	if (path === MANIFEST_PATH) return { type: "manifest", path };
	const index = INDEX_PATH_PATTERN.exec(path);
	if (index) return { type: "index", path, seq: Number(index[1]) };
	const records = RECORD_PATH_PATTERN.exec(path);
	if (records) {
		const kind = records[1];
		if (!isRecordKind(kind)) return null;
		return { type: "records", path, kind, seq: Number(records[2]) };
	}
	const media = MEDIA_PATH_PATTERN.exec(path);
	if (media) return { type: "media", path, sha256: media[1] };
	return null;
}

export function isPackagePath(path: string): boolean {
	return parsePackagePath(path) !== null;
}

function formatSeq(seq: number): string {
	if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) {
		throw new RangeError(`Invalid chunk sequence ${seq}`);
	}
	return String(seq).padStart(SEQ_DIGITS, "0");
}

export function indexChunkPath(seq: number): string {
	return `index/${formatSeq(seq)}.ndjson`;
}

export function recordChunkPath(kind: RecordKind, seq: number): string {
	return `records/${kind}/${formatSeq(seq)}.ndjson`;
}

export function mediaBlobPath(sha256: string): string {
	if (!SHA256_HEX_PATTERN.test(sha256)) throw new TypeError("Expected a lowercase hex SHA-256");
	return `media/${sha256}`;
}
