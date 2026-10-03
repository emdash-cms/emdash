/**
 * Opaque _rev token generation and validation.
 *
 * Format: base64("version:updated_at")
 * Stateless — server decodes and checks both components.
 *
 * Rules:
 * - No _rev sent → blind write (backwards-compatible)
 * - _rev matches → write proceeds, new _rev returned
 * - _rev mismatch → 409 Conflict
 */

import type { ContentItem } from "../database/repositories/types.js";
import { encodeBase64, decodeBase64 } from "../utils/base64.js";

/**
 * Generate a _rev token from a content item's version and updatedAt.
 */
export function encodeRev(item: Pick<ContentItem, "version" | "updatedAt">): string {
	return encodeBase64(`${item.version}:${item.updatedAt}`);
}

/**
 * Decode a _rev token into its components.
 * Returns null if the token is malformed.
 */
export function decodeRev(rev: string): { version: number; updatedAt: string } | null {
	try {
		const decoded = decodeBase64(rev);
		const colonIdx = decoded.indexOf(":");
		if (colonIdx === -1) return null;

		const version = parseInt(decoded.slice(0, colonIdx), 10);
		const updatedAt = decoded.slice(colonIdx + 1);

		if (isNaN(version) || !updatedAt) return null;
		return { version, updatedAt };
	} catch {
		return null;
	}
}

/**
 * Validate a _rev token against a content item.
 * Returns null if valid (or if no _rev provided), or an error message if invalid.
 */
export function validateRev(
	rev: string | undefined,
	item: ContentItem,
): { valid: true } | { valid: false; message: string } {
	// No _rev = blind write (backwards-compatible)
	if (!rev) return { valid: true };

	const decoded = decodeRev(rev);
	if (!decoded) {
		return { valid: false, message: "Malformed _rev token" };
	}

	if (decoded.version !== item.version || decoded.updatedAt !== item.updatedAt) {
		return {
			valid: false,
			message: "Content has been modified since last read (version conflict)",
		};
	}

	return { valid: true };
}
