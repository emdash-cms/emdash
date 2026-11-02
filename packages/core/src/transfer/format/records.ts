/**
 * NDJSON encoding of record and index chunks.
 *
 * A chunk is a sequence of lines, each the canonical JSON of one record (or
 * index entry) followed by `\n`, with no blank lines. A chunk holds at most
 * {@link TRANSFER_LIMITS.chunkRecords} lines and
 * {@link TRANSFER_LIMITS.chunkBytes} bytes; a record line is at most
 * {@link TRANSFER_LIMITS.recordLineBytes} bytes.
 */

import { TransferError } from "../errors.js";
import { canonicalJson, CanonicalJsonError, parseCanonicalJson } from "./canonical.js";
import { type RecordKind, type RecordOfKind, validateRecord } from "./kinds.js";
import { TRANSFER_LIMITS } from "./limits.js";
import { decodeUtf8 } from "./manifest.js";

const encoder = new TextEncoder();

/** Canonical line (without newline) for a record; enforces the line limit. */
export function encodeRecordLine(record: { kind: RecordKind; id: string }): string {
	const line = canonicalJson(record);
	const bytes = encoder.encode(line).byteLength;
	if (bytes > TRANSFER_LIMITS.recordLineBytes) {
		throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "Record exceeds the line size limit", {
			detail: { kind: record.kind, id: record.id, bytes, limit: TRANSFER_LIMITS.recordLineBytes },
		});
	}
	return line;
}

export interface DecodedRecord<K extends RecordKind> {
	record: RecordOfKind<K>;
	/** The canonical line without its newline; its SHA-256 is the record hash. */
	line: string;
}

/**
 * Validate one line as a record of `kind`. Throws `TRANSFER_RECORD_INVALID`
 * (with a location but never record content) or `TRANSFER_LIMIT_EXCEEDED`.
 */
export function decodeRecordLine<K extends RecordKind>(
	kind: K,
	line: string,
	location: { path: string; line: number },
): DecodedRecord<K> {
	if (encoder.encode(line).byteLength > TRANSFER_LIMITS.recordLineBytes) {
		throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "Record exceeds the line size limit", {
			detail: { path: location.path, line: location.line },
		});
	}
	let raw: unknown;
	try {
		raw = parseCanonicalJson(line);
	} catch (error) {
		throw new TransferError("TRANSFER_RECORD_INVALID", "Record is not canonical JSON", {
			detail: {
				path: location.path,
				line: location.line,
				reason: error instanceof CanonicalJsonError ? error.message : "invalid",
			},
		});
	}
	const result = validateRecord(kind, raw);
	if (!result.success) {
		const first = result.issues[0];
		throw new TransferError("TRANSFER_RECORD_INVALID", "Record failed validation", {
			detail: {
				path: location.path,
				line: location.line,
				field: first?.path ?? "",
				reason: first?.message ?? "invalid",
			},
		});
	}
	return { record: result.record, line };
}

/**
 * Split chunk text into lines, enforcing chunk limits and the trailing
 * newline. Returns the lines without their newlines.
 */
export function splitChunkLines(bytes: Uint8Array, path: string): string[] {
	if (bytes.byteLength > TRANSFER_LIMITS.chunkBytes) {
		throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "Chunk exceeds the size limit", {
			detail: { path, limit: TRANSFER_LIMITS.chunkBytes },
		});
	}
	const text = decodeUtf8(bytes, "TRANSFER_RECORD_INVALID");
	if (text.length === 0) {
		throw new TransferError("TRANSFER_RECORD_INVALID", "Chunk is empty", { detail: { path } });
	}
	if (!text.endsWith("\n")) {
		throw new TransferError("TRANSFER_RECORD_INVALID", "Chunk must end with a newline", {
			detail: { path },
		});
	}
	const lines = text.slice(0, -1).split("\n");
	if (lines.length > TRANSFER_LIMITS.chunkRecords) {
		throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "Chunk has too many lines", {
			detail: { path, limit: TRANSFER_LIMITS.chunkRecords },
		});
	}
	lines.forEach((line, index) => {
		if (line.length === 0) {
			throw new TransferError("TRANSFER_RECORD_INVALID", "Chunk contains a blank line", {
				detail: { path, line: index + 1 },
			});
		}
	});
	return lines;
}

/** Join canonical lines into chunk bytes, enforcing chunk limits. */
export function encodeChunk(lines: readonly string[], path: string): Uint8Array {
	if (lines.length === 0 || lines.length > TRANSFER_LIMITS.chunkRecords) {
		throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "Chunk line count out of range", {
			detail: { path, lines: lines.length },
		});
	}
	const bytes = encoder.encode(`${lines.join("\n")}\n`);
	if (bytes.byteLength > TRANSFER_LIMITS.chunkBytes) {
		throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "Chunk exceeds the size limit", {
			detail: { path, bytes: bytes.byteLength },
		});
	}
	return bytes;
}
