/**
 * Content duplication through a field mapping.
 *
 * Backs every duplicate the admin performs. The target may be the source
 * collection itself, where the mapping defaults to the identity and the copy
 * behaves like a plain duplicate. Any copy staying in its own collection gets
 * a `(Copy)` title, so it is distinguishable from the original in the list
 * they now share.
 *
 * Two checks sit at different stages and stay distinct:
 *
 *  - **Column type compatibility** is enforced when the mapping is built. A
 *    mapping may only pair fields whose `FIELD_TYPE_TO_COLUMN` entries match.
 *    Writing JSON into a REAL column is a storage error, so it is never
 *    offered — and re-checked here, not only in the UI.
 *  - **Field values** are validated when the copy is inserted, through the
 *    same `validateContentData(..., { partial: false })` pipeline creates use.
 *    A straight copy within one collection skips it because the source row
 *    already passed `partial: false`; any other mapping breaks that invariant
 *    and can assemble a row `handleContentCreate` would have rejected.
 *
 * Mapping completeness (every required target field has a source assigned) is
 * a statement about the mapping, checked once for the whole request. A
 * required field mapped to a NULL source satisfies it and fails validation
 * later, per item.
 */

import { canActOnOwn, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely, Selectable } from "kysely";

import { BylineRepository } from "../../database/repositories/byline.js";
import { ContentRepository } from "../../database/repositories/content.js";
import { OptionsRepository } from "../../database/repositories/options.js";
import { SeoRepository } from "../../database/repositories/seo.js";
import { TaxonomyRepository } from "../../database/repositories/taxonomy.js";
import type { ContentItem } from "../../database/repositories/types.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database, TaxonomyDefTable } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { SchemaRegistry } from "../../schema/registry.js";
import type { CollectionWithFields, ColumnType, Field, FieldType } from "../../schema/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { isMissingTableError } from "../../utils/db-errors.js";
import { DUPLICATE_MAX_IDS } from "../schemas/content.js";
import type { ApiResult } from "../types.js";
import { validateMediaFields } from "./validate-media-fields.js";
import { validateContentData } from "./validation.js";

/** Schema version of the saved mapping blob in `options`. */
const MAPPING_VERSION = 1;

/** Target field slug -> source field slug, or null when left unmapped. */
export type DuplicateFieldMapping = Record<string, string | null>;

export interface DuplicateMappingSourceField {
	slug: string;
	label: string;
	type: FieldType;
	columnType: ColumnType;
	required: boolean;
}

export interface DuplicateMappingTargetField extends DuplicateMappingSourceField {
	/** Source field slugs whose column type matches this target field. */
	compatibleSources: string[];
}

export interface DuplicateMappingTaxonomy {
	name: string;
	label: string;
}

export interface DuplicateMappingResponse {
	/** Whether `mapping` came from a saved blob or was derived by slug match. */
	source: "saved" | "derived";
	sourceCollection: { slug: string; label: string; fields: DuplicateMappingSourceField[] };
	targetCollection: { slug: string; label: string; fields: DuplicateMappingTargetField[] };
	mapping: DuplicateFieldMapping;
	/**
	 * Required target fields with no column-type-compatible source at all. A
	 * non-empty list means the pair cannot be mapped, whatever the user picks.
	 */
	unmappableRequired: string[];
	seo: { sourceEnabled: boolean; targetEnabled: boolean };
	taxonomies: { carried: DuplicateMappingTaxonomy[]; dropped: DuplicateMappingTaxonomy[] };
	/** Reference-edge counts for the requested `ids`. Absent when no ids were given. */
	referenceEdges?: { inbound: number; outbound: number };
}

export type DuplicateItemStatus = "copied" | "copied_not_trashed" | "failed";

export interface DuplicateItemResult {
	id: string;
	status: DuplicateItemStatus;
	targetId?: string;
	error?: string;
}

export interface DuplicateActor {
	id: string;
	role: RoleLevel;
}

export interface DuplicateManyInput {
	ids: string[];
	/** Defaults to the source collection, which makes the copy a straight one. */
	targetCollection?: string;
	mapping?: DuplicateFieldMapping;
	saveMapping?: boolean;
	trashSource?: boolean;
	/**
	 * Per-item read (and, with `trashSource`, delete) access is checked against
	 * this actor. Omit only where the caller has already authorized the request.
	 */
	actor?: DuplicateActor;
	/** Author of the copies. Defaults to `actor`, then to the source's author. */
	authorId?: string;
}

/**
 * Option key for a collection pair's saved mapping. Both slugs are validated
 * as identifiers first, so the key can never carry separator characters that
 * would make two different pairs collide.
 */
function mappingOptionName(sourceCollection: string, targetCollection: string): string {
	validateIdentifier(sourceCollection, "collection slug");
	validateIdentifier(targetCollection, "collection slug");
	return `contentmap:${sourceCollection}:${targetCollection}`;
}

function toSourceField(field: Field): DuplicateMappingSourceField {
	return {
		slug: field.slug,
		label: field.label,
		type: field.type,
		columnType: field.columnType,
		required: field.required,
	};
}

/**
 * Restrict a mapping to pairs that actually exist and agree on column type.
 * Applied to saved blobs and to client-supplied mappings alike — the dialog
 * only offers compatible pairs, and this makes that a server guarantee.
 */
function sanitizeMapping(
	raw: DuplicateFieldMapping,
	sourceFields: Map<string, Field>,
	targetFields: Map<string, Field>,
): DuplicateFieldMapping {
	const clean: DuplicateFieldMapping = {};
	for (const [targetSlug, sourceSlug] of Object.entries(raw)) {
		const target = targetFields.get(targetSlug);
		if (!target) continue;
		if (sourceSlug === null || sourceSlug === undefined) {
			clean[targetSlug] = null;
			continue;
		}
		const source = sourceFields.get(sourceSlug);
		clean[targetSlug] = source && source.columnType === target.columnType ? sourceSlug : null;
	}
	return clean;
}

/**
 * Whether every target field is copied from the field of the same slug. Only
 * such a mapping reproduces a row that already passed validation at create.
 */
function isIdentityMapping(
	mapping: DuplicateFieldMapping,
	targetFields: Map<string, Field>,
): boolean {
	for (const slug of targetFields.keys()) {
		if (mapping[slug] !== slug) return false;
	}
	return true;
}

/** Exact field-slug match, kept only where the column types agree. */
function deriveMapping(
	sourceFields: Map<string, Field>,
	targetFields: Map<string, Field>,
): DuplicateFieldMapping {
	const mapping: DuplicateFieldMapping = {};
	for (const [slug, target] of targetFields) {
		const source = sourceFields.get(slug);
		mapping[slug] = source && source.columnType === target.columnType ? slug : null;
	}
	return mapping;
}

/** Parse a stored mapping blob, ignoring anything that isn't the current shape. */
function parseStoredMapping(value: unknown): DuplicateFieldMapping | null {
	if (typeof value !== "object" || value === null) return null;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a non-null object above; every read below is re-checked
	const record = value as Record<string, unknown>;
	if (record.version !== MAPPING_VERSION) return null;
	const fields = record.fields;
	if (typeof fields !== "object" || fields === null) return null;

	const parsed: DuplicateFieldMapping = {};
	for (const [key, entry] of Object.entries(fields)) {
		if (entry === null) parsed[key] = null;
		else if (typeof entry === "string") parsed[key] = entry;
	}
	return parsed;
}

async function loadCollections(
	db: Kysely<Database>,
	sourceCollection: string,
	targetCollection: string,
): Promise<
	| { ok: true; source: CollectionWithFields; target: CollectionWithFields }
	| { ok: false; error: { code: string; message: string } }
> {
	const registry = new SchemaRegistry(db);
	const [source, target] = await Promise.all([
		registry.getCollectionWithFields(sourceCollection),
		registry.getCollectionWithFields(targetCollection),
	]);
	if (!source) {
		return {
			ok: false,
			error: {
				code: "COLLECTION_NOT_FOUND",
				message: `Collection '${sourceCollection}' not found`,
			},
		};
	}
	if (!target) {
		return {
			ok: false,
			error: {
				code: "COLLECTION_NOT_FOUND",
				message: `Collection '${targetCollection}' not found`,
			},
		};
	}
	return { ok: true, source, target };
}

function fieldMap(collection: CollectionWithFields): Map<string, Field> {
	return new Map(collection.fields.map((field) => [field.slug, field]));
}

/**
 * Taxonomy definitions attached to `sourceCollection`, split by whether they
 * also list `targetCollection`. Defs are row-per-locale; the lowest-locale row
 * wins, mirroring how the taxonomy handlers resolve a def by name.
 */
async function splitTaxonomies(
	db: Kysely<Database>,
	sourceCollection: string,
	targetCollection: string,
): Promise<{ carried: DuplicateMappingTaxonomy[]; dropped: DuplicateMappingTaxonomy[] }> {
	const rows = await db
		.selectFrom("_emdash_taxonomy_defs")
		.select(["name", "label", "collections", "locale"])
		.orderBy("locale", "asc")
		.execute();

	const seen = new Set<string>();
	const carried: DuplicateMappingTaxonomy[] = [];
	const dropped: DuplicateMappingTaxonomy[] = [];

	for (const row of rows) {
		if (seen.has(row.name)) continue;
		seen.add(row.name);
		const collections = parseDefCollections(row);
		if (!collections.has(sourceCollection)) continue;
		const entry = { name: row.name, label: row.label };
		if (collections.has(targetCollection)) carried.push(entry);
		else dropped.push(entry);
	}

	return { carried, dropped };
}

function parseDefCollections(def: Pick<Selectable<TaxonomyDefTable>, "collections">): Set<string> {
	if (!def.collections) return new Set();
	try {
		const parsed: unknown = JSON.parse(def.collections);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((slug): slug is string => typeof slug === "string"));
	} catch {
		return new Set();
	}
}

/**
 * Count reference edges touching the given entries. Outbound edges are dropped
 * by the copy (relations are collection-scoped); inbound edges keep pointing at
 * the original by construction, since the copy gets a new `translation_group`.
 */
async function countReferenceEdges(
	db: Kysely<Database>,
	groups: string[],
): Promise<{ inbound: number; outbound: number }> {
	if (groups.length === 0) return { inbound: 0, outbound: 0 };

	let inbound = 0;
	let outbound = 0;
	for (const batch of chunks(groups, SQL_BATCH_SIZE)) {
		const [inRows, outRows] = await Promise.all([
			db
				.selectFrom("_emdash_content_references")
				.select("id")
				.where("child_group", "in", batch)
				.execute(),
			db
				.selectFrom("_emdash_content_references")
				.select("id")
				.where("parent_group", "in", batch)
				.execute(),
		]);
		inbound += inRows.length;
		outbound += outRows.length;
	}
	return { inbound, outbound };
}

/**
 * Everything the duplicate dialog needs in one round trip: both field
 * lists, the mapping (saved or derived), which taxonomies carry, and — when
 * `ids` is supplied — the reference-edge counts for those entries.
 */
export async function handleDuplicateMappingGet(
	db: Kysely<Database>,
	sourceCollection: string,
	targetCollection: string,
	ids: string[] = [],
): Promise<ApiResult<DuplicateMappingResponse>> {
	try {
		if (ids.length > DUPLICATE_MAX_IDS) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: `At most ${DUPLICATE_MAX_IDS} items may be mapped at once`,
				},
			};
		}

		const collections = await loadCollections(db, sourceCollection, targetCollection);
		if (!collections.ok) return { success: false, error: collections.error };

		const sourceFields = fieldMap(collections.source);
		const targetFields = fieldMap(collections.target);

		const options = new OptionsRepository(db);
		const stored = parseStoredMapping(
			await options.get(mappingOptionName(sourceCollection, targetCollection)),
		);
		const mapping = stored
			? sanitizeMapping(stored, sourceFields, targetFields)
			: deriveMapping(sourceFields, targetFields);

		const targetFieldSummaries: DuplicateMappingTargetField[] = collections.target.fields.map(
			(field) => ({
				...toSourceField(field),
				compatibleSources: collections.source.fields
					.filter((candidate) => candidate.columnType === field.columnType)
					.map((candidate) => candidate.slug),
			}),
		);

		const unmappableRequired = targetFieldSummaries
			.filter((field) => field.required && field.compatibleSources.length === 0)
			.map((field) => field.slug);

		const taxonomies = await splitTaxonomies(db, sourceCollection, targetCollection);

		const response: DuplicateMappingResponse = {
			source: stored ? "saved" : "derived",
			sourceCollection: {
				slug: collections.source.slug,
				label: collections.source.label,
				fields: collections.source.fields.map(toSourceField),
			},
			targetCollection: {
				slug: collections.target.slug,
				label: collections.target.label,
				fields: targetFieldSummaries,
			},
			mapping,
			unmappableRequired,
			seo: {
				sourceEnabled: collections.source.hasSeo,
				targetEnabled: collections.target.hasSeo,
			},
			taxonomies,
		};

		if (ids.length > 0) {
			const repo = new ContentRepository(db);
			const items = await repo.findManyByIdOrSlug(sourceCollection, ids);
			const groups = Array.from(items.values(), (item) => item.translationGroup).filter(
				(group): group is string => typeof group === "string",
			);
			response.referenceEdges = await countReferenceEdges(db, groups);
		}

		return { success: true, data: response };
	} catch (error) {
		if (isMissingTableError(error)) {
			return {
				success: false,
				error: { code: "COLLECTION_NOT_FOUND", message: "Collection not found" },
			};
		}
		console.error("Duplicate mapping error:", error);
		return {
			success: false,
			error: {
				code: "DUPLICATE_MAPPING_ERROR",
				message: "Failed to resolve duplicate mapping",
			},
		};
	}
}

/** Apply `mapping` to one source item's data, dropping unmapped target fields. */
function applyMapping(item: ContentItem, mapping: DuplicateFieldMapping): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const [targetSlug, sourceSlug] of Object.entries(mapping)) {
		if (sourceSlug === null) continue;
		const value = item.data[sourceSlug];
		if (value === undefined) continue;
		data[targetSlug] = value;
	}
	return data;
}

function slugSourceFor(data: Record<string, unknown>, item: ContentItem): string | null {
	if (typeof data.title === "string" && data.title.length > 0) return data.title;
	if (typeof data.name === "string" && data.name.length > 0) return data.name;
	return item.slug;
}

function errorMessage(error: unknown, fallback: string): string {
	if (!(error instanceof Error)) return fallback;
	const message = error.message.toLowerCase();
	if (message.includes("unique constraint failed") || message.includes("duplicate key")) {
		return "Unique constraint violation in the target collection";
	}
	return fallback;
}

/**
 * Copy entries into a collection, which defaults to the one they came from.
 *
 * Each item's copy (row, bylines, taxonomy terms, SEO) runs in one
 * transaction. `trashSource` runs after that transaction commits: D1 has no
 * transactions, so a copy that succeeds and a trash that fails reports
 * `copied_not_trashed` — retrying the item would make a second copy.
 */
export async function handleContentDuplicateMany(
	db: Kysely<Database>,
	sourceCollection: string,
	input: DuplicateManyInput,
): Promise<ApiResult<{ results: DuplicateItemResult[] }>> {
	try {
		const { trashSource = false, actor } = input;
		const targetCollection = input.targetCollection ?? sourceCollection;

		const ids = [...new Set(input.ids)];
		if (ids.length === 0) {
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: "At least one item id is required" },
			};
		}
		if (ids.length > DUPLICATE_MAX_IDS) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: `At most ${DUPLICATE_MAX_IDS} items may be duplicated at once`,
				},
			};
		}

		const collections = await loadCollections(db, sourceCollection, targetCollection);
		if (!collections.ok) return { success: false, error: collections.error };

		const sourceFields = fieldMap(collections.source);
		const targetFields = fieldMap(collections.target);
		const options = new OptionsRepository(db);

		let mapping: DuplicateFieldMapping;
		if (input.mapping) {
			mapping = sanitizeMapping(input.mapping, sourceFields, targetFields);
		} else {
			const stored = parseStoredMapping(
				await options.get(mappingOptionName(sourceCollection, targetCollection)),
			);
			mapping = stored
				? sanitizeMapping(stored, sourceFields, targetFields)
				: deriveMapping(sourceFields, targetFields);
		}

		// Mapping completeness — about the mapping, not the values flowing
		// through it. Checked once for the whole request so an incomplete
		// mapping fails loudly instead of N times per item.
		const missingRequired = collections.target.fields
			.filter((field) => field.required && !mapping[field.slug])
			.map((field) => field.slug);
		if (missingRequired.length > 0) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: `Required field(s) in '${targetCollection}' have no source assigned: ${missingRequired.join(", ")}`,
				},
			};
		}

		const repo = new ContentRepository(db);
		const resolved = await repo.findManyByIdOrSlug(sourceCollection, ids);

		const results: DuplicateItemResult[] = [];
		const pending: Array<{ id: string; item: ContentItem }> = [];

		for (const id of ids) {
			const item = resolved.get(id);
			if (!item) {
				results.push({ id, status: "failed", error: `Content item not found: ${id}` });
				continue;
			}
			// Copying requires read access to the source. `content:read` is flat
			// (no own/any split), so ownership is expressed through the edit
			// permissions — the same substitution the per-item route makes.
			if (
				actor &&
				!canActOnOwn(actor, item.authorId ?? "", "content:edit_own", "content:edit_any")
			) {
				results.push({
					id,
					status: "failed",
					error: "Insufficient permissions to read the source item",
				});
				continue;
			}
			// Reject un-trashable items before anything is copied, so an item
			// can't end up copied with its source still in place.
			if (
				trashSource &&
				!canActOnOwn(actor, item.authorId ?? "", "content:delete_own", "content:delete_any")
			) {
				results.push({
					id,
					status: "failed",
					error: "Insufficient permissions to trash the source item",
				});
				continue;
			}
			pending.push({ id, item });
		}

		if (input.saveMapping) {
			await options.set(mappingOptionName(sourceCollection, targetCollection), {
				version: MAPPING_VERSION,
				fields: mapping,
			});
		}

		const carriedTaxonomies = new Set(
			(await splitTaxonomies(db, sourceCollection, targetCollection)).carried.map((t) => t.name),
		);
		const copySeo = collections.source.hasSeo && collections.target.hasSeo;
		const straightCopy =
			sourceCollection === targetCollection && isIdentityMapping(mapping, targetFields);

		for (const { id, item } of pending) {
			const result = await copyItem(db, {
				sourceCollection,
				targetCollection,
				item,
				mapping,
				carriedTaxonomies,
				copySeo,
				straightCopy,
				authorId: input.authorId ?? actor?.id,
			});
			if (!result.ok) {
				results.push({ id, status: "failed", error: result.error });
				continue;
			}

			if (!trashSource) {
				results.push({ id, status: "copied", targetId: result.targetId });
				continue;
			}

			try {
				const trashed = await repo.delete(sourceCollection, item.id);
				results.push({
					id,
					status: trashed ? "copied" : "copied_not_trashed",
					targetId: result.targetId,
				});
			} catch (error) {
				console.error("Duplicate-to trash error:", error);
				results.push({ id, status: "copied_not_trashed", targetId: result.targetId });
			}
		}

		// Preserve the caller's id order regardless of which items were skipped.
		const byId = new Map(results.map((entry) => [entry.id, entry]));
		return {
			success: true,
			data: { results: ids.map((id) => byId.get(id)).filter((entry) => entry !== undefined) },
		};
	} catch (error) {
		console.error("Content duplicate error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_DUPLICATE_ERROR",
				message: "Failed to duplicate content",
			},
		};
	}
}

/**
 * Copy one entry. The copy is always a draft with a fresh slug, a new
 * `translation_group` (a copy is a distinct thing, not a translation) and the
 * acting user as author; revision pointers, schedule and publication
 * timestamps start clean.
 */
async function copyItem(
	db: Kysely<Database>,
	args: {
		sourceCollection: string;
		targetCollection: string;
		item: ContentItem;
		mapping: DuplicateFieldMapping;
		carriedTaxonomies: Set<string>;
		copySeo: boolean;
		/** Identity mapping within one collection: reproduces an already-valid row. */
		straightCopy: boolean;
		authorId?: string;
	},
): Promise<{ ok: true; targetId: string } | { ok: false; error: string }> {
	const { sourceCollection, targetCollection, item, mapping, carriedTaxonomies, copySeo } = args;
	const data = applyMapping(item, mapping);

	// A copy landing in the same list as its original needs a distinguishable
	// title; across collections the original name carries as-is.
	if (sourceCollection === targetCollection) {
		if (typeof data.title === "string") data.title = `${data.title} (Copy)`;
		else if (typeof data.name === "string") data.name = `${data.name} (Copy)`;
	}

	if (!args.straightCopy) {
		const validation = await validateContentData(db, targetCollection, data, { partial: false });
		if (!validation.ok) return { ok: false, error: validation.error.message };
	}

	const mimeCheck = await validateMediaFields(db, targetCollection, data);
	if (!mimeCheck.success) {
		return { ok: false, error: mimeCheck.error?.message ?? "Invalid media field value" };
	}

	try {
		const targetId = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const slugSource = slugSourceFor(data, item);
			const slug = slugSource
				? await repo.generateUniqueSlug(targetCollection, slugSource, item.locale ?? undefined)
				: null;

			const created = await repo.create({
				type: targetCollection,
				slug,
				data,
				status: "draft",
				authorId: args.authorId || item.authorId || undefined,
				locale: item.locale ?? undefined,
			});

			// Byline rows are global and the junction pivots on
			// (collection, entry_id), so credits carry to any collection.
			const bylineRepo = new BylineRepository(trx);
			const credits = await bylineRepo.getContentBylines(sourceCollection, item.id);
			if (credits.length > 0) {
				await bylineRepo.setContentBylines(
					targetCollection,
					created.id,
					credits.map((credit) => ({
						bylineId: credit.byline.id,
						roleLabel: credit.roleLabel,
					})),
				);
			}

			if (carriedTaxonomies.size > 0) {
				const taxRepo = new TaxonomyRepository(trx);
				await taxRepo.copyEntryTermsAcross(
					sourceCollection,
					item.id,
					targetCollection,
					created.id,
					carriedTaxonomies,
				);
			}

			if (copySeo) {
				const seoRepo = new SeoRepository(trx);
				const seo = await seoRepo.get(sourceCollection, item.id);
				if (seo.title !== null || seo.description !== null || seo.image !== null || seo.noIndex) {
					await seoRepo.upsert(targetCollection, created.id, {
						title: seo.title,
						description: seo.description,
						image: seo.image,
						// The original's canonical pointed at the original.
						canonical: null,
						noIndex: seo.noIndex,
					});
				}
			}

			return created.id;
		});

		return { ok: true, targetId };
	} catch (error) {
		console.error("Duplicate-to copy error:", error);
		return { ok: false, error: errorMessage(error, "Failed to copy item") };
	}
}
