/**
 * Taxonomy and term CRUD handlers.
 *
 * i18n: terms and defs are per-locale. `(name, slug, locale)` is unique for
 * terms; `(name, locale)` for defs. Translations of the same term/def share a
 * `translation_group`. The content_taxonomies pivot stores translation_groups
 * so assignments span every locale of a post.
 */

import { sql, type Kysely, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { TaxonomyRepository, type SiblingPosition } from "../../database/repositories/taxonomy.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database, TaxonomyDefTable } from "../../database/types.js";
import { getI18nConfig, resolveConfiguredLocale } from "../../i18n/config.js";
import { invalidateTaxonomyDefsCache, invalidateTermCache } from "../../taxonomies/index.js";
import { fetchVisibleTermCounts } from "../../taxonomies/term-counts.js";
import type { ApiResult } from "../types.js";

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_GENERATED_TERM_SLUG_ATTEMPTS = 16;

function isTermSlugUniqueViolation(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	return (
		(message.includes("unique constraint failed") || message.includes("duplicate key")) &&
		message.includes("slug")
	);
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface TaxonomyDef {
	id: string;
	name: string;
	label: string;
	labelSingular?: string;
	hierarchical: boolean;
	collections: string[];
	locale: string;
	translationGroup: string | null;
}

export interface TaxonomyListResponse {
	taxonomies: TaxonomyDef[];
}

export interface TaxonomyResponse {
	taxonomy: TaxonomyDef;
}

export interface TermData {
	id: string;
	name: string;
	slug: string;
	label: string;
	parentId: string | null;
	description?: string;
	locale: string;
	translationGroup: string | null;
}

export interface TermWithCount extends TermData {
	/** Absent when the caller opted out of counts (`includeCounts: false`). */
	count?: number;
	children: TermWithCount[];
}

export interface TermListResponse {
	terms: TermWithCount[];
}

export interface TermReorderResponse {
	reordered: true;
}

export interface TermResponse {
	term: TermData;
}

export interface TermGetResponse {
	term: TermData & {
		count: number;
		children: Array<{ id: string; slug: string; label: string }>;
	};
}

export interface TermTranslationsResponse {
	translationGroup: string | null;
	translations: Array<{
		id: string;
		slug: string;
		label: string;
		locale: string;
	}>;
}

export interface TaxonomyDefTranslationsResponse {
	translationGroup: string | null;
	translations: Array<{
		id: string;
		name: string;
		label: string;
		locale: string;
	}>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build tree structure from flat terms
 */
function buildTree(flatTerms: TermWithCount[], resolveByGroup = false): TermWithCount[] {
	// `parentId` holds the parent's translation_group, so resolve links by group.
	// Key by (locale, group): a child's parent lives in the same locale, and an
	// unfiltered list mixes locales whose translated siblings share a group —
	// keying by group alone would collide and misattach children across locales.
	const byLocaleGroup = new Map<string, TermWithCount>();
	const roots: TermWithCount[] = [];
	for (const term of flatTerms) {
		const key = resolveByGroup
			? (term.translationGroup ?? term.id)
			: `${term.locale}::${term.translationGroup ?? term.id}`;
		byLocaleGroup.set(key, term);
	}
	for (const term of flatTerms) {
		const parent = term.parentId
			? byLocaleGroup.get(resolveByGroup ? term.parentId : `${term.locale}::${term.parentId}`)
			: undefined;
		if (parent) {
			parent.children.push(term);
		} else {
			roots.push(term);
		}
	}
	return roots;
}

type TaxonomyDefLookup =
	| { success: true; def: Selectable<TaxonomyDefTable> }
	| { success: false; error: { code: string; message: string } };

function taxonomyDefNotFound(name: string, locale?: string): TaxonomyDefLookup {
	return {
		success: false,
		error: {
			code: "NOT_FOUND",
			message: `Taxonomy '${name}' not found${locale !== undefined ? ` in locale '${locale}'` : ""}`,
		},
	};
}

/** Look up the exact definition addressed by a mutation. */
async function requireTaxonomyDef(
	db: Kysely<Database>,
	name: string,
	locale?: string,
): Promise<TaxonomyDefLookup> {
	let query = db.selectFrom("_emdash_taxonomy_defs").selectAll().where("name", "=", name);
	if (locale !== undefined) query = query.where("locale", "=", locale);
	const def = await query.orderBy("locale", "asc").orderBy("id", "asc").executeTakeFirst();
	return def ? { success: true, def } : taxonomyDefNotFound(name, locale);
}

/**
 * Prefer the requested locale, then the configured default. Incomplete
 * translation groups fall back deterministically so their terms remain usable.
 */
async function requireTaxonomyDefWithFallback(
	db: Kysely<Database>,
	name: string,
	locale?: string,
): Promise<TaxonomyDefLookup> {
	const defs = await db
		.selectFrom("_emdash_taxonomy_defs")
		.selectAll()
		.where("name", "=", name)
		.orderBy("locale", "asc")
		.orderBy("id", "asc")
		.execute();
	const defaultLocale = getI18nConfig()?.defaultLocale;
	const def =
		(locale ? defs.find((candidate) => candidate.locale === locale) : undefined) ??
		(defaultLocale ? defs.find((candidate) => candidate.locale === defaultLocale) : undefined) ??
		defs[0];
	return def ? { success: true, def } : taxonomyDefNotFound(name, locale);
}

/** The subset of `slugs` that still has a row in `_emdash_collections`. */
async function findExistingCollections(
	db: Kysely<Database>,
	slugs: readonly string[],
): Promise<Set<string>> {
	if (slugs.length === 0) return new Set();
	const rows = await db
		.selectFrom("_emdash_collections")
		.select("slug")
		.where("slug", "in", [...slugs])
		.execute();
	return new Set(rows.map((r) => r.slug));
}

/**
 * Reject a `collections` list naming collections that don't exist. Shared by
 * create and update so both fail the same way instead of storing a reference
 * that reads back filtered out.
 */
async function validateCollections(
	db: Kysely<Database>,
	collections: readonly string[],
): Promise<{ code: "VALIDATION_ERROR"; message: string } | null> {
	const existing = await findExistingCollections(db, collections);
	const invalid = collections.filter((slug) => !existing.has(slug));
	if (invalid.length === 0) return null;
	return {
		code: "VALIDATION_ERROR",
		message: `Unknown collection(s): ${invalid.join(", ")}`,
	};
}

/**
 * Shape one definition row for a response, dropping collection references whose
 * collection is gone. Storage is untouched — re-creating the collection
 * re-links automatically, same as `handleTaxonomyList`.
 */
async function toTaxonomyResponse(
	db: Kysely<Database>,
	row: Selectable<TaxonomyDefTable>,
): Promise<TaxonomyResponse> {
	const def = rowToDef(row);
	const realCollections = await findExistingCollections(db, def.collections);
	return {
		taxonomy: {
			...def,
			collections: def.collections.filter((slug) => realCollections.has(slug)),
		},
	};
}

/** Declared collections of a taxonomy def row (deduped, parsed from JSON). */
function defCollections(def: Selectable<TaxonomyDefTable>): string[] {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- column stores a JSON string[] written by handleTaxonomyCreate
	const parsed = def.collections ? (JSON.parse(def.collections) as string[]) : [];
	return [...new Set(parsed)];
}

function rowToDef(row: Selectable<TaxonomyDefTable>): TaxonomyDef {
	return {
		id: row.id,
		name: row.name,
		label: row.label,
		labelSingular: row.label_singular ?? undefined,
		hierarchical: row.hierarchical === 1,
		collections: row.collections ? JSON.parse(row.collections) : [],
		locale: row.locale,
		translationGroup: row.translation_group,
	};
}

// ---------------------------------------------------------------------------
// Taxonomy definition handlers
// ---------------------------------------------------------------------------

/**
 * List all taxonomy definitions
 */
export async function handleTaxonomyList(
	db: Kysely<Database>,
	options: { locale?: string } = {},
): Promise<ApiResult<TaxonomyListResponse>> {
	try {
		const locale = options.locale ? resolveConfiguredLocale(options.locale) : undefined;
		let query = db.selectFrom("_emdash_taxonomy_defs").selectAll();
		if (locale !== undefined) query = query.where("locale", "=", locale);
		const [rows, collectionRows] = await Promise.all([
			query.execute(),
			db.selectFrom("_emdash_collections").select("slug").execute(),
		]);

		// Filter orphan collection references on read so the response stays
		// consistent with `schema_list_collections`. Storage is untouched —
		// re-creating the collection re-links automatically.
		const realCollections = new Set(collectionRows.map((r) => r.slug));

		const taxonomies: TaxonomyDef[] = rows.map((row) => {
			const def = rowToDef(row);
			return { ...def, collections: def.collections.filter((slug) => realCollections.has(slug)) };
		});

		return { success: true, data: { taxonomies } };
	} catch {
		return {
			success: false,
			error: { code: "TAXONOMY_LIST_ERROR", message: "Failed to list taxonomies" },
		};
	}
}

/**
 * Get a single taxonomy definition by name.
 *
 * Definitions are per-locale, so `locale` picks which one; without it the
 * lowest-locale match wins (same rule as `handleMenuGet`).
 */
export async function handleTaxonomyGet(
	db: Kysely<Database>,
	name: string,
	options: { locale?: string } = {},
): Promise<ApiResult<TaxonomyResponse>> {
	try {
		const locale = options.locale ? resolveConfiguredLocale(options.locale) : undefined;
		const lookup = await requireTaxonomyDefWithFallback(db, name, locale);
		if (!lookup.success) return lookup;

		return { success: true, data: await toTaxonomyResponse(db, lookup.def) };
	} catch {
		return {
			success: false,
			error: { code: "TAXONOMY_GET_ERROR", message: "Failed to get taxonomy" },
		};
	}
}

/**
 * Create a new taxonomy definition
 */
export async function handleTaxonomyCreate(
	db: Kysely<Database>,
	input: {
		name: string;
		label: string;
		labelSingular?: string;
		hierarchical?: boolean;
		collections?: string[];
		locale?: string;
		translationOf?: string;
	},
): Promise<ApiResult<TaxonomyResponse>> {
	try {
		const locale = resolveConfiguredLocale(input.locale ?? getI18nConfig()?.defaultLocale ?? "en");
		if (!NAME_PATTERN.test(input.name)) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message:
						"Taxonomy name must start with a letter and contain only lowercase letters, numbers, and underscores",
				},
			};
		}

		const collections = [...new Set(input.collections ?? [])];
		const collectionError = await validateCollections(db, collections);
		if (collectionError) {
			return { success: false, error: collectionError };
		}

		let translationGroup: string | null = null;
		if (input.translationOf) {
			const source = await db
				.selectFrom("_emdash_taxonomy_defs")
				.selectAll()
				.where("id", "=", input.translationOf)
				.executeTakeFirst();
			if (!source) {
				return {
					success: false,
					error: { code: "NOT_FOUND", message: "Source taxonomy for translation not found" },
				};
			}
			translationGroup = source.translation_group ?? source.id;
		}

		// Duplicate guard scoped to locale (so the same name can exist in ES
		// and EN).
		const existing = await db
			.selectFrom("_emdash_taxonomy_defs")
			.select("id")
			.where("name", "=", input.name)
			.where("locale", "=", locale)
			.executeTakeFirst();
		if (existing) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: `Taxonomy '${input.name}' already exists in locale '${locale}'`,
				},
			};
		}

		const id = ulid();
		await db
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id,
				name: input.name,
				label: input.label,
				label_singular: input.labelSingular ?? null,
				hierarchical: input.hierarchical ? 1 : 0,
				collections: JSON.stringify(collections),
				locale,
				translation_group: translationGroup ?? id,
			})
			.execute();

		// A new def changes which taxonomies exist — drop the isolate-wide
		// defs/names caches so this isolate reflects it immediately.
		invalidateTaxonomyDefsCache();

		const row = await db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		return { success: true, data: { taxonomy: rowToDef(row) } };
	} catch (error) {
		if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
			return {
				success: false,
				error: { code: "CONFLICT", message: `Taxonomy '${input.name}' already exists` },
			};
		}
		return {
			success: false,
			error: { code: "TAXONOMY_CREATE_ERROR", message: "Failed to create taxonomy" },
		};
	}
}

/**
 * Update a taxonomy definition.
 *
 * Writes the one row `(name, locale)` resolves to — every field here belongs to
 * a single locale's definition, so translating a taxonomy and then editing the
 * translation leaves the other locales alone. `name` and `locale` are immutable
 * (renaming would strand the terms, which are keyed on `name`).
 */
export async function handleTaxonomyUpdate(
	db: Kysely<Database>,
	name: string,
	input: {
		label?: string;
		labelSingular?: string | null;
		hierarchical?: boolean;
		collections?: string[];
		locale?: string;
	},
): Promise<ApiResult<TaxonomyResponse>> {
	try {
		const locale = input.locale ? resolveConfiguredLocale(input.locale) : undefined;
		const lookup = await requireTaxonomyDef(db, name, locale);
		if (!lookup.success) return lookup;

		const collections = input.collections ? [...new Set(input.collections)] : undefined;
		if (collections !== undefined) {
			const collectionError = await validateCollections(db, collections);
			if (collectionError) {
				return { success: false, error: collectionError };
			}
		}

		const updates: {
			label?: string;
			label_singular?: string | null;
			hierarchical?: number;
			collections?: string;
		} = {};
		if (input.label !== undefined) updates.label = input.label;
		if (input.labelSingular !== undefined) updates.label_singular = input.labelSingular;
		if (input.hierarchical !== undefined) updates.hierarchical = input.hierarchical ? 1 : 0;
		if (collections !== undefined) updates.collections = JSON.stringify(collections);

		if (Object.keys(updates).length > 0) {
			await db
				.updateTable("_emdash_taxonomy_defs")
				.set(updates)
				.where("id", "=", lookup.def.id)
				.execute();
			invalidateTaxonomyDefsCache();
		}

		const row = await db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where("id", "=", lookup.def.id)
			.executeTakeFirstOrThrow();

		return { success: true, data: await toTaxonomyResponse(db, row) };
	} catch {
		return {
			success: false,
			error: { code: "TAXONOMY_UPDATE_ERROR", message: "Failed to update taxonomy" },
		};
	}
}

/**
 * Delete a taxonomy: every locale's definition, every term under that name in
 * every locale, and the term assignments those terms hold.
 *
 * There is no locale scope and no non-empty guard. Terms are keyed on `name`
 * rather than on a definition row, so leaving one locale's definition behind
 * would leave the taxonomy half-deleted — a definition with no terms, or terms
 * no definition describes.
 */
export async function handleTaxonomyDelete(
	db: Kysely<Database>,
	name: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const lookup = await requireTaxonomyDef(db, name);
		if (!lookup.success) return lookup;

		await withTransaction(db, async (trx) => {
			// `content_taxonomies.taxonomy_id` holds a term's translation_group, so
			// the assignments have to go before the terms they are matched against.
			await trx
				.deleteFrom("content_taxonomies")
				.where("taxonomy_id", "in", (eb) =>
					eb
						.selectFrom("taxonomies")
						.select(sql<string>`coalesce(translation_group, id)`.as("group"))
						.where("name", "=", name),
				)
				.execute();
			await trx.deleteFrom("taxonomies").where("name", "=", name).execute();
			await trx.deleteFrom("_emdash_taxonomy_defs").where("name", "=", name).execute();
		});

		// Covers the term caches too — see `invalidateTaxonomyDefsCache`.
		invalidateTaxonomyDefsCache();

		return { success: true, data: { deleted: true } };
	} catch (error) {
		console.error("[taxonomies] delete failed:", error);
		return {
			success: false,
			error: { code: "TAXONOMY_DELETE_ERROR", message: "Failed to delete taxonomy" },
		};
	}
}

/**
 * List every locale translation of a taxonomy def (by id or translation_group).
 */
export async function handleTaxonomyDefTranslations(
	db: Kysely<Database>,
	idOrGroup: string,
): Promise<ApiResult<TaxonomyDefTranslationsResponse>> {
	try {
		const anchor = await db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where((eb) => eb.or([eb("id", "=", idOrGroup), eb("translation_group", "=", idOrGroup)]))
			.executeTakeFirst();
		if (!anchor) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Taxonomy not found" },
			};
		}
		const group = anchor.translation_group ?? anchor.id;
		const rows = await db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where("translation_group", "=", group)
			.orderBy("locale", "asc")
			.execute();
		return {
			success: true,
			data: {
				translationGroup: group,
				translations: rows.map((r) => ({
					id: r.id,
					name: r.name,
					label: r.label,
					locale: r.locale,
				})),
			},
		};
	} catch {
		return {
			success: false,
			error: {
				code: "TAXONOMY_TRANSLATIONS_ERROR",
				message: "Failed to list taxonomy translations",
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Term handlers
// ---------------------------------------------------------------------------

/**
 * List all terms for a taxonomy (returns tree for hierarchical taxonomies)
 */
export async function handleTermList(
	db: Kysely<Database>,
	taxonomyName: string,
	options: { locale?: string; includeCounts?: boolean; resolveFallback?: boolean } = {},
): Promise<ApiResult<TermListResponse>> {
	try {
		if (options.resolveFallback && !options.locale) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "A locale is required when resolving taxonomy fallbacks",
				},
			};
		}
		// Definitions are per-locale but terms aren't bound to the def's locale —
		// use the active definition for its collection scope.
		const locale = options.locale ? resolveConfiguredLocale(options.locale) : undefined;
		const lookup = await requireTaxonomyDefWithFallback(db, taxonomyName, locale);
		if (!lookup.success) return lookup;

		const repo = new TaxonomyRepository(db);
		const terms =
			options.resolveFallback && locale
				? await repo.findByNameResolved(
						taxonomyName,
						locale,
						getI18nConfig()?.defaultLocale ?? "en",
					)
				: await repo.findByName(taxonomyName, { locale });

		// Counts match what visitors see on the public site: published (or
		// scheduled-and-due) entries that aren't soft-deleted, scoped to the
		// taxonomy's declared collections — one query for the whole list.
		// content_taxonomies.taxonomy_id stores the translation_group, so we
		// look up by group and map back to each term's id.
		const includeCounts = options.includeCounts ?? true;
		const countsByGroup = includeCounts
			? await fetchVisibleTermCounts(db, taxonomyName, defCollections(lookup.def), locale)
			: undefined;

		const termData: TermWithCount[] = terms.map((term) => ({
			id: term.id,
			name: term.name,
			slug: term.slug,
			label: term.label,
			parentId: term.parentId,
			description: typeof term.data?.description === "string" ? term.data.description : undefined,
			children: [],
			...(countsByGroup && { count: countsByGroup.get(term.translationGroup ?? term.id) ?? 0 }),
			locale: term.locale,
			translationGroup: term.translationGroup,
		}));

		const isHierarchical = lookup.def.hierarchical === 1;
		const result = isHierarchical
			? buildTree(termData, options.resolveFallback && !!locale)
			: termData;
		return { success: true, data: { terms: result } };
	} catch (error) {
		console.error("[taxonomies] term list failed:", error);
		return {
			success: false,
			error: { code: "TERM_LIST_ERROR", message: "Failed to list terms" },
		};
	}
}

/**
 * Set the manual order of one sibling group.
 *
 * `ids` names the terms to move, in the desired order; each is a row id or a
 * translation_group and resolves to the latter, because a position belongs to a
 * term rather than to one of its locales. Reordering never reparents — moving a
 * term under a different parent is a term update.
 *
 * The group is `(taxonomy, parentId)` and has no locale: `parentId` is the
 * parent's translation_group (a row id is accepted and resolved), and `null`
 * selects the top level — which for a flat taxonomy is every term.
 *
 * `ids` may be a *subset* of the group, and the listed terms are permuted
 * within the positions they already occupy. A locale only renders the terms
 * translated into it, so a caller often cannot name every member; a member left
 * out keeps its place, which is also what makes a stale list harmless.
 */
export async function handleTermReorder(
	db: Kysely<Database>,
	taxonomyName: string,
	input: { parentId?: string | null; ids: string[] },
): Promise<ApiResult<TermReorderResponse>> {
	try {
		const lookup = await requireTaxonomyDef(db, taxonomyName);
		if (!lookup.success) return lookup;

		const repo = new TaxonomyRepository(db);

		let parentId = input.parentId ?? null;
		if (parentId !== null) {
			// Children store the parent's translation_group, so a caller passing a
			// row id still addresses the right group. A parent whose anchor row is
			// gone keeps the value as given (see TaxonomyRepository.resolveParentRef).
			const parent = await repo.findById(parentId);
			if (parent) parentId = parent.translationGroup ?? parent.id;
		}

		// Every locale's rows: membership is locale-agnostic, and a term the
		// caller can't see still holds its slot.
		// The order carries into how ties are resolved, so it must be stable
		// across calls; with locales interleaved a tie falls to whichever
		// locale's label sorts first, not to the order the caller rendered.
		const members = await repo.findByName(taxonomyName, { parentId });
		const siblings: SiblingPosition[] = [];
		const seen = new Set<string>();
		const resolve = new Map<string, string>();
		for (const term of members) {
			const group = term.translationGroup ?? term.id;
			if (!seen.has(group)) {
				seen.add(group);
				siblings.push({ group, position: term.sortOrder });
			}
			// Both spellings resolve to the group: a row id, and the group itself for
			// a caller that already holds one — including when its anchor row is gone
			// and no member's id matches it.
			resolve.set(group, group);
			resolve.set(term.id, group);
		}

		const groups: string[] = [];
		for (const id of input.ids) {
			const group = resolve.get(id);
			if (!group) {
				return {
					success: false,
					error: {
						code: "REORDER_MISMATCH",
						message: `Term "${id}" is not in the sibling group being reordered`,
					},
				};
			}
			if (groups.includes(group)) {
				return {
					success: false,
					error: {
						code: "REORDER_MISMATCH",
						message: `Term "${id}" is listed more than once`,
					},
				};
			}
			groups.push(group);
		}

		await repo.reorder(groups, siblings);
		invalidateTermCache();

		return { success: true, data: { reordered: true } };
	} catch (error) {
		console.error("[taxonomies] term reorder failed:", error);
		return {
			success: false,
			error: { code: "TERM_REORDER_ERROR", message: "Failed to reorder terms" },
		};
	}
}

/**
 * Validate a parent term reference for create/update.
 *
 * Returns `null` on success or a structured error message that callers
 * wrap in their own ApiResult.
 *
 *   - `parentId === undefined` -> no-op (no parent change requested).
 *   - `parentId === null` -> caller intends to detach; no-op here.
 *   - parent must exist (FK exists -> term row not soft-deleted).
 *   - parent must live in the same taxonomy.
 *   - reject a parent in the term's own translation_group (self-parent),
 *     including the create path: a translation inherits its source's group, so
 *     `selfGroup` carries that prospective group when `termId` is absent.
 *   - on update, walk up the parent chain to detect cycles.
 */
async function validateParentTerm(
	repo: TaxonomyRepository,
	taxonomyName: string,
	termId: string | undefined,
	parentId: string | null | undefined,
	selfGroup?: string | null,
): Promise<{ code: "VALIDATION_ERROR"; message: string } | null> {
	if (parentId === undefined || parentId === null) return null;

	const parent = await repo.findById(parentId);
	if (!parent) {
		return {
			code: "VALIDATION_ERROR",
			message: `Parent term '${parentId}' not found`,
		};
	}
	if (parent.name !== taxonomyName) {
		return {
			code: "VALIDATION_ERROR",
			message: `Parent term '${parentId}' belongs to taxonomy '${parent.name}', not '${taxonomyName}'`,
		};
	}

	// Parentage keys off translation_group (what `parent_id` persists), so the
	// self-parent and cycle checks compare groups, not row ids — picking a
	// sibling translation of the term as its parent is still self-parenting.
	const parentGroup = parent.translationGroup ?? parent.id;
	let termGroup: string | null = selfGroup ?? null;
	if (termId !== undefined) {
		const term = await repo.findById(termId);
		termGroup = term ? (term.translationGroup ?? term.id) : termId;
	}
	if (termGroup !== null && parentGroup === termGroup) {
		return {
			code: "VALIDATION_ERROR",
			message: "A term cannot be its own parent",
		};
	}

	// Walk up the parent chain. Two checks fold into one walk:
	//   - Cycle detection (only on update — a non-existent term-being-
	//     created can't be its own ancestor): if the walk revisits termId
	//     the proposed parent makes the term a descendant of itself.
	//   - Depth bound: refuse to extend a chain past MAX_DEPTH ancestors.
	//     Runs on both create and update so a malicious or buggy caller
	//     can't grow the tree without limit.
	//
	// The depth-exceeded error fires only when we hit the limit AND there
	// was still chain to walk — a legitimate chain of exactly MAX_DEPTH
	// ancestors exits with `cursor === null` and is accepted.
	// `parent_id` stores a translation_group, which always equals the anchor
	// row's id, so findById(cursor) still resolves each ancestor.
	const MAX_DEPTH = 100;
	let cursor: string | null = parent.parentId;
	let steps = 0;
	while (cursor !== null && steps < MAX_DEPTH) {
		if (termGroup !== null && cursor === termGroup) {
			return {
				code: "VALIDATION_ERROR",
				message: "Cycle detected: cannot make a descendant the parent",
			};
		}
		const next = await repo.findById(cursor);
		if (!next) break;
		cursor = next.parentId;
		steps++;
	}
	if (cursor !== null && steps >= MAX_DEPTH) {
		return {
			code: "VALIDATION_ERROR",
			message: "Parent chain exceeds maximum depth",
		};
	}

	return null;
}

/**
 * Create a new term in a taxonomy
 */
export async function handleTermCreate(
	db: Kysely<Database>,
	taxonomyName: string,
	input: {
		slug?: string;
		label: string;
		parentId?: string | null;
		description?: string;
		locale?: string;
		translationOf?: string;
	},
): Promise<ApiResult<TermResponse>> {
	let attemptedSlug = input.slug;
	try {
		const locale = resolveConfiguredLocale(input.locale ?? getI18nConfig()?.defaultLocale ?? "en");
		// Taxonomy definitions are per-locale, but terms can exist in any locale
		// regardless of whether the def has been translated there. Look up the
		// def across all locales — we only care that it *exists*.
		const lookup = await requireTaxonomyDef(db, taxonomyName);
		if (!lookup.success) return lookup;

		const repo = new TaxonomyRepository(db);

		// Coerce empty-string parentId to undefined (treat as "no parent").
		const parentId =
			input.parentId === "" || input.parentId === undefined ? undefined : input.parentId;

		// Conflict check is scoped to locale (per-locale slugs are unique).
		const existing =
			input.slug === undefined ? null : await repo.findBySlug(taxonomyName, input.slug, locale);
		if (existing) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: `Term '${input.slug}' already exists in '${taxonomyName}' (${locale})`,
				},
			};
		}

		// No locale re-pointing needed: `repo.create` persists the parent's
		// translation_group in `parent_id`, so a child stays nested under the
		// parent in every locale automatically — including parents translated
		// after the child was created.

		// A translation inherits its source's translation_group; pass that
		// prospective group so validateParentTerm can reject a parent in the same
		// group (cross-locale self-parent) even though the term doesn't exist yet.
		let selfGroup: string | null = null;
		if (input.translationOf) {
			const source = await repo.findById(input.translationOf);
			selfGroup = source ? (source.translationGroup ?? source.id) : null;
		}

		// Validate parentId: must exist AND belong to the same taxonomy.
		// (Cycle check is N/A on create — the term doesn't exist yet.)
		const parentError = await validateParentTerm(
			repo,
			taxonomyName,
			undefined,
			parentId,
			selfGroup,
		);
		if (parentError) {
			return { success: false, error: parentError };
		}

		const create = (slug: string) =>
			repo.create({
				name: taxonomyName,
				slug,
				label: input.label,
				parentId: parentId ?? undefined,
				data: input.description ? { description: input.description } : undefined,
				locale,
				translationOf: input.translationOf,
			});
		let term: Awaited<ReturnType<typeof create>> | undefined;
		let lastSlugConflict: unknown;
		if (input.slug !== undefined) {
			term = await create(input.slug);
		} else {
			for (let attempt = 0; attempt < MAX_GENERATED_TERM_SLUG_ATTEMPTS; attempt++) {
				attemptedSlug = await repo.generateUniqueSlug(taxonomyName, input.label, locale);
				try {
					term = await create(attemptedSlug);
					break;
				} catch (error) {
					if (!isTermSlugUniqueViolation(error)) throw error;
					lastSlugConflict = error;
				}
			}
		}
		if (!term) throw lastSlugConflict ?? new Error("Failed to create taxonomy term");

		invalidateTermCache();

		return {
			success: true,
			data: {
				term: {
					id: term.id,
					name: term.name,
					slug: term.slug,
					label: term.label,
					parentId: term.parentId,
					description:
						typeof term.data?.description === "string" ? term.data.description : undefined,
					locale: term.locale,
					translationGroup: term.translationGroup,
				},
			},
		};
	} catch (error) {
		if (isTermSlugUniqueViolation(error)) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: `Term with slug '${attemptedSlug ?? "(generated)"}' already exists in taxonomy '${taxonomyName}'`,
				},
			};
		}
		return {
			success: false,
			error: { code: "TERM_CREATE_ERROR", message: "Failed to create term" },
		};
	}
}

/**
 * Get a single term by slug
 */
export async function handleTermGet(
	db: Kysely<Database>,
	taxonomyName: string,
	termSlug: string,
	options: { locale?: string } = {},
): Promise<ApiResult<TermGetResponse>> {
	try {
		const repo = new TaxonomyRepository(db);
		const locale = options.locale ? resolveConfiguredLocale(options.locale) : undefined;
		const term = await repo.findBySlug(taxonomyName, termSlug, locale);

		if (!term) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Term '${termSlug}' not found in taxonomy '${taxonomyName}'`,
				},
			};
		}

		// Count matches public visibility (published or scheduled-and-due, not
		// soft-deleted) scoped to the def's declared collections. The def lookup
		// falls back for incomplete translations; a term with no def at all still
		// resolves with count 0.
		const lookup = await requireTaxonomyDefWithFallback(db, taxonomyName, locale);
		const counts = await fetchVisibleTermCounts(
			db,
			taxonomyName,
			lookup.success ? defCollections(lookup.def) : [],
			locale ?? term.locale,
		);
		const count = counts.get(term.translationGroup ?? term.id) ?? 0;
		// Children share this term's translation_group as their parent_id; scope
		// to the term's own locale so the response stays within one locale's tree.
		const children = await repo.findChildren(term.id, term.locale);

		return {
			success: true,
			data: {
				term: {
					id: term.id,
					name: term.name,
					slug: term.slug,
					label: term.label,
					parentId: term.parentId,
					description:
						typeof term.data?.description === "string" ? term.data.description : undefined,
					count,
					children: children.map((c) => ({ id: c.id, slug: c.slug, label: c.label })),
					locale: term.locale,
					translationGroup: term.translationGroup,
				},
			},
		};
	} catch {
		return {
			success: false,
			error: { code: "TERM_GET_ERROR", message: "Failed to get term" },
		};
	}
}

/** List every translation of a term (by id or translation_group). */
export async function handleTermTranslations(
	db: Kysely<Database>,
	idOrGroup: string,
): Promise<ApiResult<TermTranslationsResponse>> {
	try {
		const anchor = await db
			.selectFrom("taxonomies")
			.selectAll()
			.where((eb) => eb.or([eb("id", "=", idOrGroup), eb("translation_group", "=", idOrGroup)]))
			.executeTakeFirst();
		if (!anchor) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Term not found" },
			};
		}
		const group = anchor.translation_group ?? anchor.id;
		const rows = await db
			.selectFrom("taxonomies")
			.selectAll()
			.where("translation_group", "=", group)
			.orderBy("locale", "asc")
			.execute();
		return {
			success: true,
			data: {
				translationGroup: group,
				translations: rows.map((r) => ({
					id: r.id,
					slug: r.slug,
					label: r.label,
					locale: r.locale,
				})),
			},
		};
	} catch {
		return {
			success: false,
			error: { code: "TERM_TRANSLATIONS_ERROR", message: "Failed to list term translations" },
		};
	}
}

/**
 * Update a term
 */
export async function handleTermUpdate(
	db: Kysely<Database>,
	taxonomyName: string,
	termSlug: string,
	input: { slug?: string; label?: string; parentId?: string | null; description?: string },
	options: { locale?: string } = {},
): Promise<ApiResult<TermResponse>> {
	try {
		const repo = new TaxonomyRepository(db);
		const locale = options.locale ? resolveConfiguredLocale(options.locale) : undefined;
		const term = await repo.findBySlug(taxonomyName, termSlug, locale);

		if (!term) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Term '${termSlug}' not found in taxonomy '${taxonomyName}'`,
				},
			};
		}

		// Coerce empty-string slug/parentId to undefined (treat as "no change").
		// `null` parentId is a valid request meaning "detach from parent".
		const newSlug = input.slug === "" || input.slug === undefined ? undefined : input.slug;
		const newParentId =
			input.parentId === "" || input.parentId === undefined ? undefined : input.parentId;

		// Check if new slug conflicts (per-locale uniqueness).
		if (newSlug !== undefined && newSlug !== termSlug) {
			const existing = await repo.findBySlug(taxonomyName, newSlug, locale);
			if (existing && existing.id !== term.id) {
				return {
					success: false,
					error: {
						code: "CONFLICT",
						message: `Term with slug '${newSlug}' already exists in taxonomy '${taxonomyName}'`,
					},
				};
			}
		}

		// Validate parentId: existence, same-taxonomy, no self-parent, no cycle.
		const parentError = await validateParentTerm(repo, taxonomyName, term.id, newParentId);
		if (parentError) {
			return { success: false, error: parentError };
		}

		const updated = await repo.update(term.id, {
			slug: newSlug,
			label: input.label,
			parentId: newParentId,
			data: input.description !== undefined ? { description: input.description } : undefined,
		});

		invalidateTermCache();

		if (!updated) {
			return {
				success: false,
				error: { code: "TERM_UPDATE_ERROR", message: "Failed to update term" },
			};
		}

		return {
			success: true,
			data: {
				term: {
					id: updated.id,
					name: updated.name,
					slug: updated.slug,
					label: updated.label,
					parentId: updated.parentId,
					description:
						typeof updated.data?.description === "string" ? updated.data.description : undefined,
					locale: updated.locale,
					translationGroup: updated.translationGroup,
				},
			},
		};
	} catch {
		return {
			success: false,
			error: { code: "TERM_UPDATE_ERROR", message: "Failed to update term" },
		};
	}
}

/**
 * Delete a term
 */
export async function handleTermDelete(
	db: Kysely<Database>,
	taxonomyName: string,
	termSlug: string,
	options: { locale?: string } = {},
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const repo = new TaxonomyRepository(db);
		const locale = options.locale ? resolveConfiguredLocale(options.locale) : undefined;
		const term = await repo.findBySlug(taxonomyName, termSlug, locale);

		if (!term) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Term '${termSlug}' not found in taxonomy '${taxonomyName}'`,
				},
			};
		}

		// Block deletion if the term's group still parents any child in any
		// locale — children store this group in parent_id, so removing the term
		// would orphan them (or null their parent_id via the self-FK).
		const children = await repo.findChildren(term.id);
		if (children.length > 0) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "Cannot delete term with children. Delete children first.",
				},
			};
		}

		const deleted = await repo.delete(term.id);
		if (!deleted) {
			return {
				success: false,
				error: { code: "TERM_DELETE_ERROR", message: "Failed to delete term" },
			};
		}

		invalidateTermCache();
		return { success: true, data: { deleted: true } };
	} catch {
		return {
			success: false,
			error: { code: "TERM_DELETE_ERROR", message: "Failed to delete term" },
		};
	}
}
