import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { parseAllowedMimeTypes } from "../../media/mime.js";

/**
 * MIME types allowed for upload by default (when no field-specific list
 * overrides this). Entries ending with "/" are prefix-matched (e.g.
 * "image/" matches "image/jpeg", "image/png", etc.).
 */
export const GLOBAL_UPLOAD_ALLOWLIST: readonly string[] = [
	"image/",
	"video/",
	"audio/",
	"application/pdf",
];

/**
 * Resolve the MIME allowlist for a specific field.
 *
 * Returns the field's `allowedMimeTypes` list when the field exists, is of
 * type "file" or "image", and has a non-empty list configured. Returns null
 * in all other cases — callers should fall back to GLOBAL_UPLOAD_ALLOWLIST.
 *
 * Authentication is the caller's responsibility (the upload routes already
 * gate on `media:upload`).
 */
export async function resolveFieldAllowlist(
	db: Kysely<Database>,
	fieldId: string,
): Promise<string[] | null> {
	const row = await db
		.selectFrom("_emdash_fields")
		.select(["type", "validation"])
		.where("id", "=", fieldId)
		.where("type", "in", ["file", "image"])
		.executeTakeFirst();

	return row ? parseAllowedMimeTypes(row.validation) : null;
}
