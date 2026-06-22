/**
 * Multibase-encoded multihash helpers.
 *
 * The registry RFC requires artifact checksums in multibase-multihash format:
 *
 *   <multibase-prefix><varint hash-code><varint length><digest bytes>
 *
 * For sha2-256 (the only hash function clients MUST support), `code = 0x12`,
 * `length = 0x20` (32 bytes), both fitting in a single varint byte. We encode
 * the result with the base32 multibase prefix `b` (lowercase, no padding),
 * which is the recommended encoding per the RFC and the most CID-friendly
 * choice.
 *
 * Concretely, a sha2-256 multihash is `0x12 0x20 || digest32` (34 bytes
 * total) and the multibase output is `b` + base32(those 34 bytes).
 */

import { toBase32 } from "@atcute/multibase";
import { sha256 } from "@oslojs/crypto/sha2";

/** multihash code for sha2-256 (single-byte varint). */
const SHA256_CODE = 0x12;
/** sha2-256 digest length in bytes (single-byte varint). */
const SHA256_LENGTH = 0x20;

/**
 * Compute the multibase-multihash sha2-256 checksum of the given bytes.
 *
 * @returns the base32-multibase string, e.g. `bciq...`. The output is the
 *   single-character multibase prefix `b` followed by base32 encoding of
 *   34 bytes (2-byte multihash header + 32-byte digest), totalling 56
 *   characters.
 */
export function sha256Multihash(bytes: Uint8Array): string {
	const digest = sha256(bytes);
	if (digest.length !== SHA256_LENGTH) {
		throw new Error(`expected sha256 digest to be ${SHA256_LENGTH} bytes, got ${digest.length}`);
	}
	const multihash = new Uint8Array(2 + digest.length);
	multihash[0] = SHA256_CODE;
	multihash[1] = SHA256_LENGTH;
	multihash.set(digest, 2);
	// Multibase prefix `b` indicates base32 lowercase, no padding.
	return `b${toBase32(multihash)}`;
}
