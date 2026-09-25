/**
 * Canonical JSON serialization for site packages.
 *
 * Rules (normative for formatVersion "1"):
 * - object keys are sorted by UTF-16 code unit order ({@link compareUtf16});
 * - no insignificant whitespace;
 * - strings and numbers are encoded exactly as `JSON.stringify` encodes them;
 * - object properties whose value is `undefined` are omitted;
 * - `undefined` inside an array, non-finite numbers, and any value that is not
 *   a plain object, array, string, finite number, boolean, or `null` are
 *   rejected;
 * - nesting depth is at most {@link TRANSFER_LIMITS.jsonDepth} containers
 *   (the root object or array is depth 1).
 *
 * The manifest, every NDJSON line, the plan, the receipt, and logical digests
 * all use this one implementation.
 */

import { TRANSFER_LIMITS } from "./limits.js";

export class CanonicalJsonError extends Error {
	readonly path: string;

	constructor(message: string, path: string) {
		super(`${message} at ${path}`);
		this.name = "CanonicalJsonError";
		this.path = path;
	}
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function compareUtf16(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

export function canonicalJson(value: unknown, options: { maxDepth?: number } = {}): string {
	const maxDepth = options.maxDepth ?? TRANSFER_LIMITS.jsonDepth;
	const parts: string[] = [];
	write(value, parts, 0, maxDepth, "$");
	return parts.join("");
}

function write(value: unknown, out: string[], depth: number, maxDepth: number, path: string): void {
	if (value === null) {
		out.push("null");
		return;
	}
	switch (typeof value) {
		case "string":
			out.push(JSON.stringify(value));
			return;
		case "number":
			if (!Number.isFinite(value)) throw new CanonicalJsonError("Non-finite number", path);
			out.push(JSON.stringify(value));
			return;
		case "boolean":
			out.push(value ? "true" : "false");
			return;
		case "object":
			break;
		default:
			throw new CanonicalJsonError(`Unsupported ${typeof value} value`, path);
	}

	if (depth + 1 > maxDepth) {
		throw new CanonicalJsonError(`Nesting deeper than ${maxDepth}`, path);
	}

	if (Array.isArray(value)) {
		out.push("[");
		for (let index = 0; index < value.length; index++) {
			if (index > 0) out.push(",");
			const item: unknown = value[index];
			if (item === undefined)
				throw new CanonicalJsonError("Undefined array item", `${path}[${index}]`);
			write(item, out, depth + 1, maxDepth, `${path}[${index}]`);
		}
		out.push("]");
		return;
	}

	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new CanonicalJsonError("Non-plain object", path);
	}
	const entries: Array<[string, unknown]> = Object.entries(value);
	const present = entries
		.filter(([, item]) => item !== undefined)
		.toSorted(([a], [b]) => compareUtf16(a, b));
	out.push("{");
	present.forEach(([key, item], index) => {
		if (index > 0) out.push(",");
		out.push(JSON.stringify(key), ":");
		write(item, out, depth + 1, maxDepth, `${path}.${key}`);
	});
	out.push("}");
}

/**
 * Container nesting depth of a JSON text, measured without parsing it so an
 * adversarial document cannot exhaust the parser's stack first. Returns
 * `Infinity` as soon as `limit` is exceeded.
 */
export function measureJsonDepth(text: string, limit: number = TRANSFER_LIMITS.jsonDepth): number {
	let depth = 0;
	let max = 0;
	let inString = false;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (inString) {
			if (code === 0x5c) index++;
			else if (code === 0x22) inString = false;
			continue;
		}
		if (code === 0x22) inString = true;
		else if (code === 0x7b || code === 0x5b) {
			depth++;
			if (depth > max) {
				max = depth;
				if (max > limit) return Number.POSITIVE_INFINITY;
			}
		} else if (code === 0x7d || code === 0x5d) depth--;
	}
	return max;
}

/**
 * Parse a JSON text that must already be in canonical form. Throws
 * {@link CanonicalJsonError} when the depth limit is exceeded, the text is not
 * valid JSON, or re-serializing the parsed value does not reproduce the text
 * byte for byte.
 */
export function parseCanonicalJson(text: string, options: { maxDepth?: number } = {}): unknown {
	const maxDepth = options.maxDepth ?? TRANSFER_LIMITS.jsonDepth;
	if (measureJsonDepth(text, maxDepth) > maxDepth) {
		throw new CanonicalJsonError(`Nesting deeper than ${maxDepth}`, "$");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new CanonicalJsonError("Invalid JSON", "$");
	}
	if (canonicalJson(parsed, { maxDepth }) !== text) {
		throw new CanonicalJsonError("JSON is not in canonical form", "$");
	}
	return parsed;
}
