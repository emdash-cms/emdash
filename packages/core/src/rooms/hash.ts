import { sha256 } from "@oslojs/crypto/sha2";
import { encodeHexLowerCase } from "@oslojs/encoding";

import { canonicalJson } from "../transfer/format/canonical.js";

/** Far above real content, and low enough that recursion can't exhaust the stack. */
const MAX_HASH_DEPTH = 1000;

const encoder = new TextEncoder();

/**
 * SHA-256 of a value's RFC 8785 canonical JSON, as lowercase hex. `undefined` hashes as `null`,
 * so an absent value and a cleared one compare equal. Throws `CanonicalJsonError` for a value
 * that isn't JSON or nests deeper than 1,000 levels.
 */
export function hashValue(value: unknown): string {
	const json = canonicalJson(value === undefined ? null : value, { maxDepth: MAX_HASH_DEPTH });
	return encodeHexLowerCase(sha256(encoder.encode(json)));
}
