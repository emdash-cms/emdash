import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Opaque server-issued finalize secret (store only `sha256Hex` on the order). */
export function randomFinalizeTokenHex(byteLength = 24): string {
	return randomBytes(byteLength).toString("hex");
}

/** Constant-time compare for two 64-char hex SHA-256 digests. */
export function equalSha256HexDigest(a: string, b: string): boolean {
	if (a.length !== 64 || b.length !== 64) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
	} catch {
		return false;
	}
}
