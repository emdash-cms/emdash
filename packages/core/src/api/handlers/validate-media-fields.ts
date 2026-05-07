import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { matchesMimeAllowlist } from "../../media/mime.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import type { ApiResult } from "../types.js";

interface FieldRow {
	slug: string;
	type: string;
	allowedMimeTypes: string[];
}

interface MediaRefValue {
	id?: unknown;
	provider?: unknown;
	mimeType?: unknown;
}

function asMediaRef(value: unknown): MediaRefValue | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object") return null;
	return value as MediaRefValue;
}

async function loadMediaFieldsForCollection(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<FieldRow[]> {
	const rows = await db
		.selectFrom("_emdash_fields")
		.innerJoin("_emdash_collections", "_emdash_collections.id", "_emdash_fields.collection_id")
		.select(["_emdash_fields.slug", "_emdash_fields.type", "_emdash_fields.validation"])
		.where("_emdash_collections.slug", "=", collectionSlug)
		.where((eb) =>
			eb.or([eb("_emdash_fields.type", "=", "file"), eb("_emdash_fields.type", "=", "image")]),
		)
		.execute();

	const out: FieldRow[] = [];
	for (const row of rows) {
		if (!row.validation) continue;
		try {
			const parsed = JSON.parse(row.validation) as { allowedMimeTypes?: string[] };
			const list = parsed.allowedMimeTypes;
			if (!list || list.length === 0) continue;
			out.push({ slug: row.slug, type: row.type, allowedMimeTypes: list });
		} catch {
			// Malformed validation JSON — skip
		}
	}
	return out;
}

export async function validateMediaFields(
	db: Kysely<Database>,
	collectionSlug: string,
	data: Record<string, unknown>,
): Promise<ApiResult<true>> {
	const fields = await loadMediaFieldsForCollection(db, collectionSlug);
	if (fields.length === 0) return { success: true, data: true };

	// Collect local media ids that need a MIME lookup
	const localIds = new Set<string>();
	for (const field of fields) {
		const ref = asMediaRef(data[field.slug]);
		if (!ref) continue;
		const provider = typeof ref.provider === "string" ? ref.provider : "local";
		if (provider === "local" && typeof ref.id === "string") {
			localIds.add(ref.id);
		}
	}

	// Batch-load local media MIMEs
	const idList = [...localIds];
	const mimeById = new Map<string, string>();
	if (idList.length > 0) {
		for (const batch of chunks(idList, SQL_BATCH_SIZE)) {
			const rows = await db
				.selectFrom("media")
				.select(["id", "mime_type"])
				.where("id", "in", batch)
				.execute();
			for (const r of rows) mimeById.set(r.id, r.mime_type);
		}
	}

	for (const field of fields) {
		const value = data[field.slug];
		if (value === null || value === undefined) continue;
		const ref = asMediaRef(value);
		if (!ref) continue;

		const provider = typeof ref.provider === "string" ? ref.provider : "local";
		let mime: string | undefined;
		if (provider === "local") {
			if (typeof ref.id !== "string") continue;
			mime = mimeById.get(ref.id);
		} else {
			if (typeof ref.mimeType === "string") mime = ref.mimeType;
		}

		if (!mime) {
			return {
				success: false,
				error: {
					code: "INVALID_MIME_FOR_FIELD",
					message: `Field '${field.slug}' references media with unknown MIME type`,
				},
			};
		}

		if (!matchesMimeAllowlist(mime, field.allowedMimeTypes)) {
			return {
				success: false,
				error: {
					code: "INVALID_MIME_FOR_FIELD",
					message: `Field '${field.slug}' does not accept ${mime}`,
				},
			};
		}
	}

	return { success: true, data: true };
}
