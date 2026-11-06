import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { matchesMimeAllowlist, parseAllowedMimeTypes } from "../../media/mime.js";
import { requestCached } from "../../request-cache.js";
import { BlockTypeRegistry } from "../../schema/block-type-registry.js";
import type { BlockType } from "../../schema/block-types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import type { ApiResult } from "../types.js";

interface FieldRow {
	slug: string;
	type: string;
	allowedMimeTypes: string[];
	blockTypes?: BlockType[];
}

interface MediaTarget {
	path: string;
	value: unknown;
	allowedMimeTypes: string[];
}

interface MediaRefValue {
	id?: unknown;
	provider?: unknown;
	mimeType?: unknown;
	darkVariant?: unknown;
}

function asMediaRef(value: unknown): MediaRefValue | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}

function fail(message: string): ApiResult<never> {
	return { success: false, error: { code: "INVALID_MIME_FOR_FIELD", message } };
}

function addTarget(
	targets: MediaTarget[],
	path: string,
	value: unknown,
	allowedMimeTypes: readonly string[] | undefined,
	includeDarkVariant: boolean,
): void {
	if (!allowedMimeTypes?.length || value == null) return;
	targets.push({ path, value, allowedMimeTypes: [...allowedMimeTypes] });
	const ref = includeDarkVariant ? asMediaRef(value) : null;
	if (ref && "darkVariant" in ref && ref.darkVariant != null) {
		targets.push({
			path: `${path}.darkVariant`,
			value: ref.darkVariant,
			allowedMimeTypes: [...allowedMimeTypes],
		});
	}
}

function collectBlockTargets(
	targets: MediaTarget[],
	field: FieldRow,
	value: unknown,
): ApiResult<true> {
	if (!Array.isArray(value)) return { success: true, data: true };
	const types = new Map((field.blockTypes ?? []).map((type) => [type.slug, type]));
	for (const [index, block] of value.entries()) {
		if (!block || typeof block !== "object" || Array.isArray(block)) continue;
		const typeSlug = "_type" in block && typeof block._type === "string" ? block._type : undefined;
		const versionNumber =
			"_version" in block && typeof block._version === "number" ? block._version : undefined;
		const key = "_key" in block && typeof block._key === "string" ? block._key : String(index);
		const type = typeSlug ? types.get(typeSlug) : undefined;
		const version = type?.versions.find((candidate) => candidate.version === versionNumber);
		if (!type || !version || version.unsupportedTypes?.length) {
			return {
				success: false,
				error: {
					code: "UNSUPPORTED_FIELD_TYPE",
					message: `Field '${field.slug}' block '${key}' has no retained definition`,
				},
			};
		}
		for (const nestedField of version.fields) {
			const nestedValue = nestedField.slug in block ? block[nestedField.slug] : undefined;
			const nestedPath = `${field.slug}.${key}.${nestedField.slug}`;
			if (nestedField.type !== "image" && nestedField.type !== "file") continue;
			addTarget(
				targets,
				nestedPath,
				nestedValue,
				nestedField.validation?.allowedMimeTypes,
				nestedField.type === "image",
			);
		}
	}
	return { success: true, data: true };
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
		.where("_emdash_fields.type", "in", ["file", "image", "blocks"])
		.execute();

	const out: FieldRow[] = [];
	const allBlockTypes = rows.some((row) => row.type === "blocks")
		? await new BlockTypeRegistry(db).listBlockTypes()
		: [];
	const blockTypeBySlug = new Map(allBlockTypes.map((type) => [type.slug, type]));
	for (const row of rows) {
		if (row.type === "blocks") {
			let validation: unknown;
			try {
				validation = row.validation ? JSON.parse(row.validation) : {};
			} catch {
				validation = {};
			}
			let configured: unknown[] = [];
			if (validation && typeof validation === "object" && !Array.isArray(validation)) {
				const allowed =
					"allowedTypes" in validation && Array.isArray(validation.allowedTypes)
						? validation.allowedTypes
						: [];
				const retired =
					"retiredTypes" in validation && Array.isArray(validation.retiredTypes)
						? validation.retiredTypes
						: [];
				configured = [...allowed, ...retired];
			}
			out.push({
				slug: row.slug,
				type: row.type,
				allowedMimeTypes: [],
				blockTypes: configured.flatMap((slug) => {
					const type = typeof slug === "string" ? blockTypeBySlug.get(slug) : undefined;
					return type ? [type] : [];
				}),
			});
			continue;
		}
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
	const targets: MediaTarget[] = [];
	for (const field of fields) {
		const value = data[field.slug];
		if (field.type === "blocks") {
			const collected = collectBlockTargets(targets, field, value);
			if (!collected.success) return collected;
		} else {
			addTarget(targets, field.slug, value, field.allowedMimeTypes, field.type === "image");
		}
	}
	if (targets.length === 0) return { success: true, data: true };

	// Collect local media ids that need a MIME lookup
	const localIds = new Set<string>();
	for (const target of targets) {
		const ref = asMediaRef(target.value);
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

	for (const target of targets) {
		const ref = asMediaRef(target.value);
		if (!ref) continue;

		const provider = typeof ref.provider === "string" ? ref.provider : "local";

		// External providers carry mimeType in the ref; trust it as-is.
		// Local media: look up the stored mimeType by id.
		let mime: string | undefined;
		if (provider === "local") {
			if (typeof ref.id !== "string") {
				return fail(`Field '${target.path}' references media with an invalid id`);
			}
			mime = mimeById.get(ref.id);
			if (!mime) {
				return fail(`Field '${target.path}' references media with unknown MIME type`);
			}
		} else {
			if (typeof ref.mimeType !== "string") {
				return fail(`Field '${target.path}' requires a mimeType declaration for non-local media`);
			}
			// TODO: long-term, consider a server-side HEAD probe or provider-vouched
			// MIMEs for non-local refs; for now the constraint is only as strong as
			// the client that constructed the ref.
			mime = ref.mimeType;
		}

		if (!matchesMimeAllowlist(mime, target.allowedMimeTypes)) {
			return fail(`Field '${target.path}' does not accept ${mime}`);
		}
	}

	return { success: true, data: true };
}
