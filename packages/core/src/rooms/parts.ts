/**
 * Values over 1 MB are stored in parts, on every host: Durable Object SQLite rows max out at
 * 2 MB, and smaller rows keep each database write bounded.
 */

import { COMPACTION_BYTES } from "./limits.js";

export function splitBytes(bytes: Uint8Array): Uint8Array[] {
	const parts = [bytes.subarray(0, COMPACTION_BYTES)];
	for (let start = COMPACTION_BYTES; start < bytes.byteLength; start += COMPACTION_BYTES) {
		parts.push(bytes.subarray(start, start + COMPACTION_BYTES));
	}
	return parts;
}

/** Parts of at most `COMPACTION_BYTES` characters, never splitting a surrogate pair. */
export function splitText(text: string): string[] {
	const parts: string[] = [];
	let start = 0;
	do {
		let end = Math.min(start + COMPACTION_BYTES, text.length);
		if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
		parts.push(text.slice(start, end));
		start = end;
	} while (start < text.length);
	return parts;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Drivers read bytes back as a `Uint8Array` (node:sqlite), an `ArrayBuffer` (libSQL, Durable
 * Object SQLite) or a pooled `Buffer` (pg) whose `buffer` holds other values too, so the parts
 * are always copied.
 */
export function joinParts(parts: unknown[]): Uint8Array {
	const views = parts.map(asBytes);
	const joined = new Uint8Array(views.reduce((total, view) => total + view.byteLength, 0));
	let offset = 0;
	for (const view of views) {
		joined.set(view, offset);
		offset += view.byteLength;
	}
	return joined;
}

function asBytes(value: unknown): Uint8Array {
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	throw new TypeError("Room storage read back a value that isn't bytes");
}
