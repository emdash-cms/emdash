import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { matchesMimeAllowlist, parseAllowedMimeTypes } from "../../media/mime.js";
import { requestCached } from "../../request-cache.js";
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
	if (typeof value !== "object" || Array.isArray(value)) return null;
	return value as MediaRefValue;
}

function fail(message: string): ApiResult<never> {
	return { success: false, error: { code: "INVALID_MIME_FOR_FIELD", message } };
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
		.where("_emdash_fields.type", "in", ["file", "image"])
		.execute();

	const out: FieldRow[] = [];
	for (const row of rows) {
		const list = parseAllowedMimeTypes(row.validation);
		if (!list) continue;
		out.push({ slug: row.slug, type: row.type, allowedMimeTypes: list });
	}
	return out;
}

export async function validateMediaFields(
	db: Kysely<Database>,
	collectionSlug: string,
	data: Record<string, unknown>,
): Promise<ApiResult<true>> {
	// Cache is keyed on slug only. If a handler creates/modifies a field and
	// then writes content in the same request (e.g. bulk import), the cached
	// list will be stale for that request. This is an edge case in normal use.
	const fields = await requestCached(`mediaFields:${collectionSlug}`, () =>
		loadMediaFieldsForCollection(db, collectionSlug),
	);
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

		// External providers carry mimeType in the ref; trust it as-is.
		// Local media: look up the stored mimeType by id.
		let mime: string | undefined;
		if (provider === "local") {
			if (typeof ref.id !== "string") {
				return fail(`Field '${field.slug}' references media with an invalid id`);
			}
			mime = mimeById.get(ref.id);
			if (!mime) {
				return fail(`Field '${field.slug}' references media with unknown MIME type`);
			}
		} else {
			if (typeof ref.mimeType !== "string") {
				return fail(`Field '${field.slug}' requires a mimeType declaration for non-local media`);
			}
			// TODO: long-term, consider a server-side HEAD probe or provider-vouched
			// MIMEs for non-local refs; for now the constraint is only as strong as
			// the client that constructed the ref.
			mime = ref.mimeType;
		}

		if (!matchesMimeAllowlist(mime, field.allowedMimeTypes)) {
			return fail(`Field '${field.slug}' does not accept ${mime}`);
		}
	}

	return { success: true, data: true };
}
