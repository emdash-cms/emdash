import { verificationError } from "./errors.js";
import type { VerificationResult } from "./errors.js";

const SHA2_256_CODE = 0x12;
const SHA2_256_LENGTH = 32;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export type MultihashAlgorithm = "sha2-256";

export interface DecodedMultihash {
	algorithm: MultihashAlgorithm;
	digest: Uint8Array;
}

/** Decodes a lowercase base32 multibase-encoded multihash. */
export function decodeMultihash(value: string): VerificationResult<DecodedMultihash> {
	if (!value.startsWith("b")) {
		return verificationError(
			"INVALID_MULTIHASH",
			"Checksums must be lowercase base32 multibase-encoded multihashes.",
		);
	}

	const bytes = decodeBase32(value.slice(1));
	if (bytes === null) {
		return verificationError("INVALID_MULTIHASH", "The multibase checksum is malformed.");
	}

	const code = readVarint(bytes, 0);
	if (code === null) {
		return verificationError("INVALID_MULTIHASH", "The multihash algorithm code is malformed.");
	}
	const length = readVarint(bytes, code.nextOffset);
	if (length === null || length.value !== bytes.length - length.nextOffset) {
		return verificationError("INVALID_MULTIHASH", "The multihash digest length is malformed.");
	}
	if (code.value !== SHA2_256_CODE) {
		return verificationError("UNSUPPORTED_MULTIHASH", "The multihash algorithm is not supported.");
	}
	if (length.value !== SHA2_256_LENGTH) {
		return verificationError("INVALID_MULTIHASH", "The sha2-256 digest must be 32 bytes.");
	}

	return {
		success: true,
		value: { algorithm: "sha2-256", digest: bytes.slice(length.nextOffset) },
	};
}

export async function computeMultihash(
	bytes: Uint8Array,
	algorithm: MultihashAlgorithm = "sha2-256",
): Promise<VerificationResult<string>> {
	if (algorithm !== "sha2-256") {
		return verificationError("UNSUPPORTED_MULTIHASH", "The multihash algorithm is not supported.");
	}

	try {
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
		const multihash = new Uint8Array(2 + digest.length);
		multihash[0] = SHA2_256_CODE;
		multihash[1] = digest.length;
		multihash.set(digest, 2);
		return { success: true, value: `b${encodeBase32(multihash)}` };
	} catch {
		return verificationError("UNSUPPORTED_MULTIHASH", "The sha2-256 algorithm is unavailable.");
	}
}

export async function verifyMultihash(
	bytes: Uint8Array,
	expected: string,
): Promise<VerificationResult<true>> {
	const decoded = decodeMultihash(expected);
	if (!decoded.success) return decoded;

	const actual = await computeDigest(bytes, decoded.value.algorithm);
	if (!actual.success) return actual;
	if (!compareDigestBytes(actual.value, decoded.value.digest)) {
		return verificationError(
			"CHECKSUM_MISMATCH",
			"The resource bytes do not match the expected checksum.",
		);
	}
	return { success: true, value: true };
}

/**
 * Compare public checksum digest bytes without early exit. Digests are public
 * integrity metadata, so a portable byte loop is preferable to a Node-only
 * timing primitive while still avoiding an ordinary equality short circuit.
 */
export function compareDigestBytes(left: Uint8Array, right: Uint8Array): boolean {
	let difference = left.length ^ right.length;
	const maximumLength = Math.max(left.length, right.length);
	for (let index = 0; index < maximumLength; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

async function computeDigest(
	bytes: Uint8Array,
	algorithm: MultihashAlgorithm,
): Promise<VerificationResult<Uint8Array>> {
	if (algorithm !== "sha2-256") {
		return verificationError("UNSUPPORTED_MULTIHASH", "The multihash algorithm is not supported.");
	}
	try {
		return {
			success: true,
			value: new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
		};
	} catch {
		return verificationError("UNSUPPORTED_MULTIHASH", "The sha2-256 algorithm is unavailable.");
	}
}

function readVarint(
	bytes: Uint8Array,
	offset: number,
): { value: number; nextOffset: number } | null {
	let value = 0;
	let shift = 0;
	for (let index = offset; index < bytes.length && index < offset + 5; index += 1) {
		const byte = bytes[index];
		if (byte === undefined) return null;
		value |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { value, nextOffset: index + 1 };
		shift += 7;
	}
	return null;
}

function encodeBase32(bytes: Uint8Array): string {
	let result = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			result += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31] ?? "";
			bits -= 5;
		}
	}
	if (bits > 0) result += BASE32_ALPHABET[(buffer << (5 - bits)) & 31] ?? "";
	return result;
}

function decodeBase32(value: string): Uint8Array | null {
	if (value.length === 0) return null;
	let buffer = 0;
	let bits = 0;
	const output: number[] = [];
	for (const character of value) {
		const digit = BASE32_ALPHABET.indexOf(character);
		if (digit === -1) return null;
		buffer = (buffer << 5) | digit;
		bits += 5;
		if (bits >= 8) {
			output.push((buffer >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
	return new Uint8Array(output);
}
