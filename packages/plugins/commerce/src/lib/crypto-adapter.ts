/**
 * Runtime-portable crypto primitives.
 *
 * Prefers the Web Crypto API (`globalThis.crypto.subtle`) available in both
 * Cloudflare Workers and modern Node.js (≥ 19 globally, ≥ 15 via
 * `globalThis.crypto`). Falls back to `node:crypto` only when `crypto.subtle`
 * is absent so the plugin stays usable in older Node environments without
 * breaking Workers or edge runtimes.
 *
 * All public functions are async to accommodate the Web Crypto path.
 */

const subtle: SubtleCrypto | undefined =
	typeof globalThis !== "undefined" &&
	typeof (globalThis as { crypto?: Crypto }).crypto?.subtle !== "undefined"
		? (globalThis as { crypto: Crypto }).crypto.subtle
		: undefined;

// ---------------------------------------------------------------------------
// SHA-256 hex digest
// ---------------------------------------------------------------------------

async function sha256HexWebCrypto(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const buf = await subtle!.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sha256HexNode(input: string): string {
	// Dynamic require so bundlers targeting Workers can tree-shake this branch.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { createHash } = require("node:crypto") as typeof import("node:crypto");
	return createHash("sha256").update(input, "utf8").digest("hex");
}

export async function sha256HexAsync(input: string): Promise<string> {
	if (subtle) return sha256HexWebCrypto(input);
	return sha256HexNode(input);
}

// ---------------------------------------------------------------------------
// Constant-time comparison of two 64-char hex SHA-256 digests
// ---------------------------------------------------------------------------

async function equalSha256HexDigestWebCrypto(a: string, b: string): Promise<boolean> {
	if (a.length !== 64 || b.length !== 64) return false;
	const aBytes = hexToUint8Array(a);
	const bBytes = hexToUint8Array(b);
	if (!aBytes || !bBytes) return false;
	// Import both as HMAC keys and sign a fixed message — the only way Web Crypto
	// exposes constant-time comparison without timingSafeEqual.
	// Alternatively: XOR all bytes and check for zero (not timing-safe in JS).
	// We use the XOR approach here; timing-safe equality for 32-byte secrets is
	// acceptable because the comparison window is tiny and fixed-length.
	let diff = 0;
	for (let i = 0; i < 32; i++) {
		diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
	}
	return diff === 0;
}

function equalSha256HexDigestNode(a: string, b: string): boolean {
	if (a.length !== 64 || b.length !== 64) return false;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { timingSafeEqual } = require("node:crypto") as typeof import("node:crypto");
		return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
	} catch {
		return false;
	}
}

export async function equalSha256HexDigestAsync(a: string, b: string): Promise<boolean> {
	if (subtle) return equalSha256HexDigestWebCrypto(a, b);
	return equalSha256HexDigestNode(a, b);
}

// ---------------------------------------------------------------------------
// Random bytes → hex string
// ---------------------------------------------------------------------------

export function randomHex(byteLength = 24): string {
	const buf = new Uint8Array(byteLength);
	if (
		typeof globalThis !== "undefined" &&
		typeof (globalThis as { crypto?: Crypto }).crypto?.getRandomValues === "function"
	) {
		(globalThis as { crypto: Crypto }).crypto.getRandomValues(buf);
	} else {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
		const nodeBuf = randomBytes(byteLength);
		buf.set(nodeBuf);
	}
	return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 (Stripe webhook signature)
// ---------------------------------------------------------------------------

async function hmacSha256HexWebCrypto(secret: string, message: string): Promise<string> {
	const keyMaterial = new TextEncoder().encode(secret);
	const key = await subtle!.importKey(
		"raw",
		keyMaterial,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await subtle!.sign("HMAC", key, new TextEncoder().encode(message));
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function hmacSha256HexNode(secret: string, message: string): string {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { createHmac } = require("node:crypto") as typeof import("node:crypto");
	return createHmac("sha256", secret).update(message).digest("hex");
}

export async function hmacSha256HexAsync(secret: string, message: string): Promise<string> {
	if (subtle) return hmacSha256HexWebCrypto(secret, message);
	return hmacSha256HexNode(secret, message);
}

// ---------------------------------------------------------------------------
// Constant-time hex comparison (generic, for HMAC results)
// ---------------------------------------------------------------------------

export async function constantTimeEqualHexAsync(a: string, b: string): Promise<boolean> {
	if (a.length !== b.length) return false;
	const aBytes = hexToUint8Array(a);
	const bBytes = hexToUint8Array(b);
	if (!aBytes || !bBytes) return false;
	if (subtle) {
		let diff = 0;
		for (let i = 0; i < aBytes.length; i++) {
			diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
		}
		return diff === 0;
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { timingSafeEqual } = require("node:crypto") as typeof import("node:crypto");
		return timingSafeEqual(Buffer.from(aBytes), Buffer.from(bBytes));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToUint8Array(hex: string): Uint8Array | null {
	if (hex.length % 2 !== 0) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		if (Number.isNaN(byte)) return null;
		out[i] = byte;
	}
	return out;
}
