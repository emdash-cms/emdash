import type { Kysely } from "kysely";

import { ContentRepository } from "../../database/repositories/content.js";
import {
	RelationRepository,
	type ContentReference,
	type CreateRelationInput,
	type Relation,
	type UpdateRelationInput,
} from "../../database/repositories/relation.js";
import { RevisionRepository } from "../../database/repositories/revision.js";
import { InvalidCursorError } from "../../database/repositories/types.js";
import type { ContentItem } from "../../database/repositories/types.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import { invalidateCollectionCache } from "../../object-cache/index.js";
import {
	pageStagedGroups,
	readStagedReferences,
	type PageOfGroups,
} from "../../references/staged.js";
import { requestCached } from "../../request-cache.js";
import { invalidateSchemaCache } from "../../schema/index.js";
import { SchemaRegistry } from "../../schema/registry.js";
import type { ApiResult } from "../types.js";
import {
	constraintsForRelationSide,
	referenceFieldConstraints,
	validateReferenceSelection,
	type ReferenceFieldConstraints,
} from "./validate-references.js";

/** Map an edge-read failure: a bad pagination cursor is a 400 client error,
 * everything else is the generic 500-shaped reference-read error. */
function referencesGetError(error: unknown): ApiResult<never> {
	if (error instanceof InvalidCursorError) {
		return { success: false, error: { code: "INVALID_CURSOR", message: error.message } };
	}
	return {
		success: false,
		error: { code: "REFERENCES_GET_ERROR", message: "Failed to get references" },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** True for SQLite UNIQUE / Postgres unique_violation messages (matches the
 * fingerprint used in the content handlers). Narrow enough not to catch NOT
 * NULL / CHECK violations whose messages also say "constraint". */
function isUniqueViolation(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	return message.includes("unique constraint failed") || message.includes("duplicate key");
}

export async function handleRelationCreate(
	db: Kysely<Database>,
	input: CreateRelationInput,
): Promise<ApiResult<{ relation: Relation }>> {
	try {
		const repo = new RelationRepository(db);

		// Invariant: a relation must point at collections that exist. There is no
		// SQL FK (the edge endpoints are content translation_groups, which
		// precludes one), so a ghost collection would yield a
		// structurally-valid-but-permanently-useless relation.
		const registry = new SchemaRegistry(db);
		for (const collection of [input.parentCollection, input.childCollection]) {
			if (!(await registry.getCollection(collection))) {
				return {
					success: false,
					error: {
						code: "COLLECTION_NOT_FOUND",
						message: `Collection '${collection}' not found`,
					},
				};
			}
		}

		const relation = await repo.create(input);
		return { success: true, data: { relation } };
	} catch (error) {
		if (isUniqueViolation(error)) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: "A relation with this slug already exists",
				},
			};
		}
		return {
			success: false,
			error: { code: "RELATION_CREATE_ERROR", message: "Failed to create relation" },
		};
	}
}

/**
 * A relation plus what deleting it would take with it: the reference fields
 * that view it, and how many links it holds. Both delete dialogs enumerate
 * these before the user confirms.
 */
export interface RelationWithUsage extends Relation {
	boundFields: BoundField[];
	linkCount: number;
}

export async function handleRelationGet(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<{ relation: RelationWithUsage }>> {
	try {
		const repo = new RelationRepository(db);
		const relation = await repo.findById(id);
		if (!relation) {
			return { success: false, error: { code: "NOT_FOUND", message: "Relation not found" } };
		}
		const [boundFields, edgeCounts] = await Promise.all([
			fieldsBoundToRelation(db, relation.slug),
			repo.countEdgesByRelation(),
		]);
		return {
			success: true,
			data: { relation: { ...relation, boundFields, linkCount: edgeCounts.get(relation.id) ?? 0 } },
		};
	} catch {
		return {
			success: false,
			error: { code: "RELATION_GET_ERROR", message: "Failed to get relation" },
		};
	}
}

/**
 * List relations, optionally only those `collection` takes part in.
 *
 * The admin's relation picker filters this way: a reference field can only bind
 * to a relation with its own collection on one end.
 */
export async function handleRelationList(
	db: Kysely<Database>,
	opts: { collection?: string } = {},
): Promise<ApiResult<{ relations: RelationWithUsage[] }>> {
	try {
		const repo = new RelationRepository(db);
		const [relations, boundByRelation, edgeCounts] = await Promise.all([
			opts.collection ? repo.findForCollection(opts.collection) : repo.list(),
			fieldsBoundByRelation(db),
			repo.countEdgesByRelation(),
		]);
		return {
			success: true,
			data: {
				relations: relations.map((relation) => ({
					...relation,
					boundFields: boundByRelation.get(relation.slug) ?? [],
					linkCount: edgeCounts.get(relation.id) ?? 0,
				})),
			},
		};
	} catch {
		return {
			success: false,
			error: { code: "RELATION_LIST_ERROR", message: "Failed to list relations" },
		};
	}
}

export async function handleRelationUpdate(
	db: Kysely<Database>,
	id: string,
	input: UpdateRelationInput,
): Promise<ApiResult<{ relation: Relation }>> {
	try {
		const repo = new RelationRepository(db);
		const relation = await repo.update(id, input);
		if (!relation) {
			return { success: false, error: { code: "NOT_FOUND", message: "Relation not found" } };
		}
		return { success: true, data: { relation } };
	} catch {
		return {
			success: false,
			error: { code: "RELATION_UPDATE_ERROR", message: "Failed to update relation" },
		};
	}
}

/** A reference field that views a relation, and which end it views it from. */
export interface BoundField {
	collectionSlug: string;
	fieldSlug: string;
	side: "parent" | "child";
}

/**
 * Every reference field on the site, grouped by the slug of the relation it
 * binds.
 *
 * Filtered in JS rather than through `json_extract`: `_emdash_fields` holds one
 * row per field on the whole site, and the reference-typed subset of that is
 * small enough that a scan beats a dialect-specific JSON path. Grouping the
 * whole set in one pass also keeps the relations list to a single scan instead
 * of one per row.
 */
export async function fieldsBoundByRelation(
	db: Kysely<Database>,
): Promise<Map<string, BoundField[]>> {
	const rows = await db
		.selectFrom("_emdash_fields")
		.innerJoin("_emdash_collections", "_emdash_collections.id", "_emdash_fields.collection_id")
		.select([
			"_emdash_fields.slug as fieldSlug",
			"_emdash_collections.slug as collectionSlug",
			"_emdash_fields.validation as validation",
		])
		.where("_emdash_fields.type", "=", "reference")
		.execute();

	const byRelation = new Map<string, BoundField[]>();
	for (const row of rows) {
		if (!row.validation) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.validation);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.relation !== "string") continue;
		const bound: BoundField = {
			collectionSlug: row.collectionSlug,
			fieldSlug: row.fieldSlug,
			side: parsed.relationSide === "child" ? "child" : "parent",
		};
		const list = byRelation.get(parsed.relation);
		if (list) list.push(bound);
		else byRelation.set(parsed.relation, [bound]);
	}
	return byRelation;
}

/** Every reference field bound to one relation, across both of its ends. */
export async function fieldsBoundToRelation(
	db: Kysely<Database>,
	relationSlug: string,
): Promise<BoundField[]> {
	return (await fieldsBoundByRelation(db)).get(relationSlug) ?? [];
}

/**
 * Delete a relation, the reference fields bound to it, and its edges.
 *
 * A relation is only ever deleted deliberately — from the relations admin page,
 * or by the checkbox on a field delete — and it cannot leave a field pointing at
 * nothing, so the fields go with it either way. Callers show the count first;
 * `deletedFields` reports what actually went.
 *
 * Order matters: fields first, then the relation row and its edges. On D1
 * `withTransaction` degrades to sequential statements, so an interrupted run
 * leaves a relation with fewer bound fields — visible on the relations page and
 * finishable — rather than fields pointing at a relation that no longer exists.
 */
export async function handleRelationDelete(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<{ deleted: true; deletedFields: string[] }>> {
	try {
		const repo = new RelationRepository(db);
		const relation = await repo.findById(id);
		if (!relation) {
			return { success: false, error: { code: "NOT_FOUND", message: "Relation not found" } };
		}

		const bound = await fieldsBoundToRelation(db, relation.slug);

		const deleted = await withTransaction(db, async (trx) => {
			const registry = new SchemaRegistry(trx);
			for (const field of bound) {
				await registry.deleteField(field.collectionSlug, field.fieldSlug);
			}
			return new RelationRepository(trx).delete(id);
		});

		if (!deleted) {
			return { success: false, error: { code: "NOT_FOUND", message: "Relation not found" } };
		}

		for (const collection of new Set(bound.map((f) => f.collectionSlug))) {
			invalidateCollectionCache(collection);
			invalidateSchemaCache(collection);
		}

		return {
			success: true,
			data: {
				deleted: true,
				deletedFields: bound.map((f) => `${f.collectionSlug}.${f.fieldSlug}`),
			},
		};
	} catch (error) {
		console.error("Relation delete error:", error);
		return {
			success: false,
			error: { code: "RELATION_DELETE_ERROR", message: "Failed to delete relation" },
		};
	}
}

export type EntryRef = {
	id: string;
	slug: string | null;
	collection: string;
	/**
	 * Display label sourced from the collection's configured `titleField`, then
	 * `title`, then `name` — `null` when none is set, leaving the client to fall
	 * back to slug/id. Mirrors the admin's `getEntryTitle`.
	 */
	title: string | null;
	/** The actual locale of the resolved variant — see `pickVariant`. */
	locale: string | null;
	/**
	 * The edge's target: the translation group `id` was resolved from. Stable
	 * across locales, unlike `id`, so callers comparing a ref against a content
	 * row (the admin's picker) match the entry rather than one of its variants.
	 */
	translationGroup: string | null;
	sortOrder?: number;
};

/**
 * Display title for a resolved entry: the collection's configured `titleField`,
 * then `title`, then `name`, else null.
 */
function entryTitle(data: Record<string, unknown>, titleField?: string): string | null {
	if (titleField) {
		const configured = data[titleField];
		if (typeof configured === "string" && configured.length > 0) return configured;
	}
	if (typeof data.title === "string" && data.title.length > 0) return data.title;
	if (typeof data.name === "string" && data.name.length > 0) return data.name;
	return null;
}

/**
 * The collection's configured `titleField`, memoized for the request: a single
 * content read hydrates every reference field, and several of them commonly
 * target the same collection.
 */
export async function getReferenceTitleField(
	db: Kysely<Database>,
	collection: string,
): Promise<string | undefined> {
	return requestCached(`reference-title-field:${collection}`, async () => {
		const row = await db
			.selectFrom("_emdash_collections")
			.select("title_field")
			.where("slug", "=", collection)
			.executeTakeFirst();
		return row?.title_field ?? undefined;
	});
}

/** Resolve a relation from an id OR its slug. */
async function resolveRelation(
	repo: RelationRepository,
	idOrSlug: string,
): Promise<Relation | null> {
	return (await repo.findById(idOrSlug)) ?? (await repo.findBySlug(idOrSlug));
}

/**
 * Pick the locale variant matching `locale`, falling back to the first entry
 * (lowest locale code). The fallback is intentional — an edge is keyed by
 * `translation_group`, so a referenced entry that exists only in another locale
 * is still a real reference — but the returned ref carries the variant's actual
 * `locale` so callers never mistake a fallback for the requested locale.
 */
function pickVariant(items: ContentItem[], locale: string | null): ContentItem | undefined {
	return items.find((i) => i.locale === locale) ?? items[0];
}

/**
 * Resolve edge groups to loadable entries in `collection` at `locale`.
 * Dangling groups (no surviving entry) are skipped — cleanup is a later slice.
 *
 * All groups are loaded in one batched query (chunked at `SQL_BATCH_SIZE`)
 * rather than a `findTranslations` per edge, so a parent with N children costs
 * a constant number of queries, not N+1. Edge order (the caller's `sort_order`)
 * is preserved by iterating `edges`.
 *
 * `includeDrafts` is false for callers without `content:read_drafts`: the load
 * is restricted to published entries so a draft/scheduled entry referenced by an
 * edge is skipped exactly like a dangling one, never leaking its id/slug/locale.
 */
export function resolveEntries(
	content: ContentRepository,
	collection: string,
	edges: ContentReference[],
	pick: (e: ContentReference) => string,
	locale: string | null,
	includeDrafts: boolean,
	titleField?: string,
): Promise<EntryRef[]> {
	return resolveGroupSelection(
		content,
		collection,
		edges.map((edge) => ({ group: pick(edge), sortOrder: edge.sortOrder })),
		locale,
		includeDrafts,
		titleField,
	);
}

/**
 * `resolveEntries` for a selection that has no links behind it yet — a pending
 * one staged in a draft revision, which is already a list of translation groups
 * in the order the editor chose. Position stands in for the `sort_order` the
 * links will carry once it is published.
 */
export function resolveEntryGroups(
	content: ContentRepository,
	collection: string,
	groups: string[],
	locale: string | null,
	includeDrafts: boolean,
	titleField?: string,
): Promise<EntryRef[]> {
	return resolveGroupSelection(
		content,
		collection,
		groups.map((group, index) => ({ group, sortOrder: index })),
		locale,
		includeDrafts,
		titleField,
	);
}

async function resolveGroupSelection(
	content: ContentRepository,
	collection: string,
	selection: Array<{ group: string; sortOrder: number }>,
	locale: string | null,
	includeDrafts: boolean,
	titleField?: string,
): Promise<EntryRef[]> {
	const all = await content.findTranslationsForGroups(
		collection,
		selection.map((entry) => entry.group),
		{ publishedOnly: !includeDrafts },
	);

	// Group the flat variant list by translation_group so each selected entry can
	// pick its own locale variant.
	const variantsByGroup = new Map<string, ContentItem[]>();
	for (const item of all) {
		if (item.translationGroup == null) continue;
		const list = variantsByGroup.get(item.translationGroup);
		if (list) list.push(item);
		else variantsByGroup.set(item.translationGroup, [item]);
	}

	const refs: EntryRef[] = [];
	for (const selected of selection) {
		const variants = variantsByGroup.get(selected.group);
		if (!variants) continue;
		const entry = pickVariant(variants, locale);
		if (!entry) continue;
		refs.push({
			id: entry.id,
			slug: entry.slug,
			collection,
			title: entryTitle(entry.data, titleField),
			locale: entry.locale,
			translationGroup: entry.translationGroup,
			sortOrder: selected.sortOrder,
		});
	}
	return refs;
}

/** Pagination inputs for the edge read endpoints. */
export type PageOptions = { limit?: number; cursor?: string };

/**
 * The page of a pending selection this end stages, when there is one.
 *
 * These routes address a relation and a side; a staged selection is keyed by the
 * field slug the entry API takes it under, so the field viewing this end is what
 * connects them. Returns undefined when the caller may not see drafts, the entry
 * has no draft, or the draft stages nothing for this field — all of which mean
 * the published links are the answer.
 */
async function stagedPageFor(
	db: Kysely<Database>,
	options: {
		collection: string;
		relationSlug: string;
		side: "parent" | "child";
		draftRevisionId: string | null | undefined;
		includeDrafts: boolean;
		page: PageOptions;
	},
): Promise<PageOfGroups | undefined> {
	if (!options.includeDrafts || !options.draftRevisionId) return undefined;

	const field = constraintsForRelationSide(
		await referenceFieldConstraints(db, options.collection),
		options.relationSlug,
		options.side,
	);
	if (!field) return undefined;

	const revision = await new RevisionRepository(db).findById(options.draftRevisionId);
	const groups = readStagedReferences(revision?.data)?.[field.slug];
	if (!groups) return undefined;

	return pageStagedGroups(groups, options.page);
}

export async function handleReferenceChildrenGet(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	relation: string,
	page: PageOptions = {},
	includeDrafts = false,
): Promise<ApiResult<{ children: EntryRef[]; nextCursor?: string }>> {
	try {
		const repo = new RelationRepository(db);
		const content = new ContentRepository(db);

		const rel = await resolveRelation(repo, relation);
		if (!rel)
			return { success: false, error: { code: "NOT_FOUND", message: "Relation not found" } };
		if (collection !== rel.parentCollection) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "Entry is not the parent side of this relation",
				},
			};
		}

		const entry = await content.findByIdOrSlug(collection, entryId);
		// A caller without draft access must not anchor on a non-published entry —
		// return NOT_FOUND (not 403) so they can't probe draft ids by status code,
		// mirroring the single-item content read.
		if (!entry?.translationGroup || (!includeDrafts && entry.status !== "published")) {
			return { success: false, error: { code: "NOT_FOUND", message: "Content entry not found" } };
		}

		const titleField = await getReferenceTitleField(db, rel.childCollection);

		// A pending selection replaces the published one for a caller that may see
		// it, page for page — the entry read answers the same way, and a walk that
		// started on one of them must not continue on the other.
		const staged = await stagedPageFor(db, {
			collection,
			relationSlug: rel.slug,
			side: "parent",
			draftRevisionId: entry.draftRevisionId,
			includeDrafts,
			page,
		});
		if (staged) {
			const children = await resolveEntryGroups(
				content,
				rel.childCollection,
				staged.groups,
				entry.locale,
				includeDrafts,
				titleField,
			);
			return { success: true, data: { children, nextCursor: staged.nextCursor } };
		}

		const edges = await repo.getChildrenPage(rel.id, entry.translationGroup, page);
		const children = await resolveEntries(
			content,
			rel.childCollection,
			edges.items,
			(e) => e.childGroup,
			entry.locale,
			includeDrafts,
			titleField,
		);
		return { success: true, data: { children, nextCursor: edges.nextCursor } };
	} catch (error) {
		return referencesGetError(error);
	}
}

/**
 * A selection expressed in the identifiers the link table actually stores:
 * `translation_group` on both ends, because an edge names a thing rather than
 * one locale's row of it.
 */
export interface ReferenceSelectionWrite extends ResolvedReferenceTargets {
	/** The selecting entry's own translation group. */
	entryGroup: string;
}

/**
 * The same selection, resolved before the entry it belongs to is known — which
 * is what a create has to do, since its row does not exist until it is written
 * and, on D1, writing it cannot be taken back.
 */
export interface ResolvedReferenceTargets {
	/** The relation, by id or slug — `setChildren` / `setParents` take either. */
	relation: string;
	/** The end of the relation the selecting entry sits on. */
	side: "parent" | "child";
	/** The selected entries' translation groups, in the caller's order. */
	groups: string[];
}

/**
 * Resolve a bound field's selection to what the link table stores, without
 * writing anything and without needing the selecting entry to exist.
 *
 * The field decides the relation and the end it views: a field on the `parent`
 * end selects children, one on the `child` end selects the parents pointing at
 * it. `entryGroup` is the selecting entry's own translation group when it has
 * one — the far-side count discounts links it already holds, since replacing a
 * selection with itself adds nothing. A new entry passes `null`: it holds no
 * links yet.
 */
async function resolveReferenceTargets(
	db: Kysely<Database>,
	collection: string,
	constraints: ReferenceFieldConstraints,
	selectedIds: string[],
	entryGroup: string | null,
): Promise<ApiResult<ResolvedReferenceTargets>> {
	const repo = new RelationRepository(db);
	const content = new ContentRepository(db);
	const side = constraints.relationSide;

	const rel = await resolveRelation(repo, constraints.relation);
	if (!rel) return { success: false, error: { code: "NOT_FOUND", message: "Relation not found" } };

	const ownCollection = side === "parent" ? rel.parentCollection : rel.childCollection;
	const otherCollection = side === "parent" ? rel.childCollection : rel.parentCollection;
	if (collection !== ownCollection) {
		return {
			success: false,
			error: {
				code: "VALIDATION_ERROR",
				message: `Entry is not the ${side} side of this relation`,
			},
		};
	}

	const selection = validateReferenceSelection(constraints, selectedIds);
	if (!selection.success) return selection;

	// Resolve every selected entry within the relation's other collection in one
	// batch (constant queries, not an N+1 of point lookups for a set up to 1000).
	// An id that does not resolve there fails collection-agreement (invariant 3);
	// order is preserved by iterating the caller's ids.
	const resolved = await content.findManyByIdOrSlug(otherCollection, selectedIds);
	const groups: string[] = [];
	for (const selectedId of selectedIds) {
		const other = resolved.get(selectedId);
		if (!other?.translationGroup) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `${side === "parent" ? "Child" : "Parent"} entry '${selectedId}' not found in ${otherCollection}`,
				},
			};
		}
		groups.push(other.translationGroup);
	}

	const far = await validateOppositeSideLimit(db, {
		relationId: rel.id,
		farLimit: side === "parent" ? rel.maxParentsPerChild : rel.maxChildrenPerParent,
		side,
		entryGroup,
		groups,
		labels: selectedIds,
	});
	if (!far.success) return far;

	return { success: true, data: { relation: rel.id, side, groups } };
}

/**
 * Check what a selection does to the *other* end's cardinality.
 *
 * Cardinality binds both ends, but only one end ever selects: a field on the
 * parent side that hands a child its second parent breaks `maxParentsPerChild`
 * even though the parent's own limit is untouched. Links the selecting entry
 * already holds are discounted — replacing a selection with itself adds nothing.
 *
 * `labels` names each group the way the caller addressed it, so the message
 * quotes the id someone typed. Publication has only the groups, which it stages;
 * it quotes those.
 */
export async function validateOppositeSideLimit(
	db: Kysely<Database>,
	options: {
		relationId: string;
		/** The opposite end's limit. `null` is unlimited — nothing to check. */
		farLimit: number | null;
		/** The end the selecting entry sits on. */
		side: "parent" | "child";
		entryGroup: string | null;
		groups: string[];
		labels?: string[];
	},
): Promise<ApiResult<true>> {
	const { farLimit, side, groups } = options;
	if (farLimit === null || groups.length === 0) return { success: true, data: true };

	const counts = await new RelationRepository(db).countEdgesByGroup(
		options.relationId,
		side === "parent" ? "child" : "parent",
		groups,
		options.entryGroup,
	);
	for (const [index, group] of groups.entries()) {
		if ((counts.get(group) ?? 0) + 1 <= farLimit) continue;
		const farSide = side === "parent" ? "parent" : "child";
		const label = options.labels?.[index] ?? group;
		return {
			success: false,
			error: {
				code: "VALIDATION_ERROR",
				message:
					farLimit === 1
						? `Entry '${label}' already has a ${farSide} on this relation, which allows one.`
						: `Entry '${label}' already has the maximum of ${farLimit} ${farSide} entries on this relation.`,
			},
		};
	}
	return { success: true, data: true };
}

/**
 * {@link resolveReferenceTargets} for an entry that already exists, anchoring the
 * selection on that entry's translation group.
 */
async function resolveReferenceSide(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	constraints: ReferenceFieldConstraints,
	selectedIds: string[],
): Promise<ApiResult<ReferenceSelectionWrite>> {
	const entry = await new ContentRepository(db).findByIdOrSlug(collection, entryId);
	if (!entry?.translationGroup) {
		return { success: false, error: { code: "NOT_FOUND", message: "Content entry not found" } };
	}

	const resolved = await resolveReferenceTargets(
		db,
		collection,
		constraints,
		selectedIds,
		entry.translationGroup,
	);
	if (!resolved.success) return resolved;
	return { success: true, data: { ...resolved.data, entryGroup: entry.translationGroup } };
}

/**
 * Replace one end's links from an already-resolved selection.
 *
 * Resolution has already proved the relation, the entry and every selected entry
 * exist, so nothing here fails on the caller's input. What it can still hit is
 * the far end's limit closing between resolving and writing — a slot another
 * request took in that window. The write refuses the edge rather than exceeding
 * the limit, and throws so the save reports it; the throw carries an `apiError`
 * the content handlers map to a response.
 */
export async function writeReferenceSelection(
	db: Kysely<Database>,
	selection: ReferenceSelectionWrite,
): Promise<void> {
	const repo = new RelationRepository(db);
	const rel = await resolveRelation(repo, selection.relation);
	if (!rel) return;

	const rejected =
		selection.side === "parent"
			? await repo.setChildren(rel.id, selection.entryGroup, selection.groups)
			: await repo.setParents(rel.id, selection.entryGroup, selection.groups);
	if (rejected.length > 0) {
		const farSide = selection.side === "parent" ? "parent" : "child";
		throw Object.assign(
			new Error(
				`Entry '${rejected[0]}' already has the maximum number of ${farSide} entries on this relation.`,
			),
			{ apiError: { code: "VALIDATION_ERROR" } },
		);
	}

	// A link is part of what a cached entry renders on both ends — a parent's
	// selection and a child's backlinks — while no row of either collection has
	// changed. Nothing else here would tell those snapshots they are stale.
	invalidateCollectionCache(rel.parentCollection);
	if (rel.childCollection !== rel.parentCollection) {
		invalidateCollectionCache(rel.childCollection);
	}
}

/**
 * Replace a reference field's selection on one entry, addressed by field slug.
 *
 * The field decides which relation and which end: a field bound to the parent
 * end replaces that entry's children, one bound to the child end replaces the
 * parents pointing at it. This is what the entry create/update body writes
 * through, so a site addresses a selection the way it addresses any other field.
 */
export async function setReferenceSelection(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	fieldSlug: string,
	selectedIds: string[],
): Promise<ApiResult<{ relationId: string; entryGroup: string }>> {
	const resolved = await resolveReferenceSelection(db, collection, entryId, fieldSlug, selectedIds);
	if (!resolved.success) return resolved;
	await writeReferenceSelection(db, resolved.data);
	return {
		success: true,
		data: { relationId: resolved.data.relation, entryGroup: resolved.data.entryGroup },
	};
}

/**
 * `setReferenceSelection` up to but not including the write.
 *
 * A collection that keeps drafts stages the result in its draft revision instead
 * of writing links, so a save reports a bad id or an over-long selection exactly
 * as a direct write would, and publication has nothing left to resolve.
 */
export async function resolveReferenceSelection(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	fieldSlug: string,
	selectedIds: string[],
): Promise<ApiResult<ReferenceSelectionWrite>> {
	const constraints = (await referenceFieldConstraints(db, collection)).get(fieldSlug);
	if (!constraints) return notAReferenceField(fieldSlug, collection);
	return resolveReferenceSide(db, collection, entryId, constraints, selectedIds);
}

/**
 * `resolveReferenceSelection` for an entry that does not exist yet.
 *
 * A create resolves its whole payload before it writes its row, because on D1
 * that row is committed the moment it is written: a selection that cannot be
 * resolved has to be refused while there is still nothing to take back.
 *
 * `entryGroup` is the group the new row will join — a new translation inherits
 * the source's — or null when the row starts a group of its own and so holds no
 * links yet.
 */
export async function resolveReferenceSelectionTargets(
	db: Kysely<Database>,
	collection: string,
	fieldSlug: string,
	selectedIds: string[],
	entryGroup: string | null,
): Promise<ApiResult<ResolvedReferenceTargets>> {
	const constraints = (await referenceFieldConstraints(db, collection)).get(fieldSlug);
	if (!constraints) return notAReferenceField(fieldSlug, collection);
	return resolveReferenceTargets(db, collection, constraints, selectedIds, entryGroup);
}

function notAReferenceField(fieldSlug: string, collection: string): ApiResult<never> {
	return {
		success: false,
		error: {
			code: "VALIDATION_ERROR",
			message: `Field '${fieldSlug}' is not a reference field on ${collection}`,
		},
	};
}

export async function handleReferenceParentsGet(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	relation: string,
	page: PageOptions = {},
	includeDrafts = false,
): Promise<ApiResult<{ parents: EntryRef[]; nextCursor?: string }>> {
	try {
		const repo = new RelationRepository(db);
		const content = new ContentRepository(db);

		const rel = await resolveRelation(repo, relation);
		if (!rel)
			return { success: false, error: { code: "NOT_FOUND", message: "Relation not found" } };
		if (collection !== rel.childCollection) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "Entry is not the child side of this relation",
				},
			};
		}

		const entry = await content.findByIdOrSlug(collection, entryId);
		// Same draft-anchor guard as the children read: a non-draft-reader anchoring
		// on an unpublished entry gets NOT_FOUND, not its backlinks.
		if (!entry?.translationGroup || (!includeDrafts && entry.status !== "published")) {
			return { success: false, error: { code: "NOT_FOUND", message: "Content entry not found" } };
		}

		const titleField = await getReferenceTitleField(db, rel.parentCollection);

		// As on the children read: a field bound to this end stages its pending
		// selection in the entry's draft, and that is what a drafts-aware caller
		// pages through.
		const staged = await stagedPageFor(db, {
			collection,
			relationSlug: rel.slug,
			side: "child",
			draftRevisionId: entry.draftRevisionId,
			includeDrafts,
			page,
		});
		if (staged) {
			const parents = await resolveEntryGroups(
				content,
				rel.parentCollection,
				staged.groups,
				entry.locale,
				includeDrafts,
				titleField,
			);
			return { success: true, data: { parents, nextCursor: staged.nextCursor } };
		}

		const edges = await repo.getParentsPage(rel.id, entry.translationGroup, page);
		const parents = await resolveEntries(
			content,
			rel.parentCollection,
			edges.items,
			(e) => e.parentGroup,
			entry.locale,
			includeDrafts,
			titleField,
		);
		return { success: true, data: { parents, nextCursor: edges.nextCursor } };
	} catch (error) {
		return referencesGetError(error);
	}
}
