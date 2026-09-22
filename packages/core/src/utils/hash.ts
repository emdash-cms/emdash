export const MAX_CONTENT_HASH_BYTES = 8 * 1024 * 1024;

function formatContentHash(hash: Uint8Array): string {
	const hashHex = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `sha1:${hashHex}`;
}

/**
 * SHA-256 hash of a string, truncated to 16 hex chars (64 bits).
 * For cache invalidation / ETags — not for security.
 */
export async function hashString(content: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
	return Array.from(new Uint8Array(buf).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
}

/**
 * Compute content hash using Web Crypto API
 *
 * Uses SHA-1 which is the fastest option in SubtleCrypto.
 * SHA-1 is cryptographically weak but fine for content deduplication
 * where we only need to detect identical files, not resist attacks.
 *
 * Returns hex string prefixed with "sha1:" for future-proofing
 */
export async function computeContentHash(content: Uint8Array | ArrayBuffer): Promise<string> {
	// SubtleCrypto.digest() requires BufferSource (ArrayBuffer | ArrayBufferView<ArrayBuffer>).
	// Uint8Array.buffer is ArrayBufferLike which may include SharedArrayBuffer in the type system,
	// so we ensure we have a plain ArrayBuffer.
	let buf: ArrayBuffer;
	if (content instanceof ArrayBuffer) {
		buf = content;
	} else if (
		content.buffer instanceof ArrayBuffer &&
		content.byteOffset === 0 &&
		content.byteLength === content.buffer.byteLength
	) {
		buf = content.buffer;
	} else {
		buf = new ArrayBuffer(content.byteLength);
		new Uint8Array(buf).set(content);
	}
	const hashBuffer = await crypto.subtle.digest("SHA-1", buf);
	return formatContentHash(new Uint8Array(hashBuffer));
}
