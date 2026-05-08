import { hasPermission } from "@emdash-cms/auth";
import type { RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";

interface UserLike {
	id: string;
	role: RoleLevel;
}

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
 */
export async function resolveFieldAllowlist(
	db: Kysely<Database>,
	fieldId: string,
	user: UserLike | null | undefined,
): Promise<string[] | null> {
	if (!hasPermission(user, "content:create")) return null;
	const row = await db
		.selectFrom("_emdash_fields")
		.select(["type", "validation"])
		.where("id", "=", fieldId)
		.executeTakeFirst();

	if (!row) return null;
	if (row.type !== "file" && row.type !== "image") return null;
	if (!row.validation) return null;

	try {
		const parsed: unknown = JSON.parse(row.validation);
		if (typeof parsed !== "object" || parsed === null) return null;
		const list = (parsed as { allowedMimeTypes?: string[] }).allowedMimeTypes;
		if (!list || list.length === 0) return null;
		return list;
	} catch {
		return null;
	}
}
