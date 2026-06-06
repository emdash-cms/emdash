/**
 * Taxonomy and term CRUD handlers.
 *
 * i18n: terms and defs are per-locale. `(name, slug, locale)` is unique for
 * terms; `(name, locale)` for defs. Translations of the same term/def share a
 * `translation_group`. The content_taxonomies pivot stores translation_groups
 * so assignments span every locale of a post.
 */

import type { Kysely, Selectable } from "kysely";
import { ulid } from "ulidx";

import { TaxonomyRepository } from "../../database/repositories/taxonomy.js";
import type { Database, TaxonomyDefTable } from "../../database/types.js";
import { invalidateTermCache } from "../../taxonomies/index.js";
import type { ApiResult } from "../types.js";

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

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
	count: number;
	children: TermWithCount[];
}

export interface TermListResponse {
	terms: TermWithCount[];
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
function buildTree(flatTerms: TermWithCount[]): TermWithCount[] {
	const map = new Map<string, TermWithCount>();
	const roots: TermWithCount[] = [];
	for (const term of flatTerms) map.set(term.id, term);
	for (const term of flatTerms) {
		if (term.parentId && map.has(term.parentId)) {
			map.get(term.parentId)!.children.push(term);
		} else {
			roots.push(term);
		}
	}
	return roots;
}

/**
 * Look up a taxonomy definition by name (optionally scoped to a locale).
 * Returns the lowest-locale match when no locale is provided.
 */
async function requireTaxonomyDef(
	db: Kysely<Database>,
	name: string,
	locale?: string,
): Promise<
	| { success: true; def: Selectable<TaxonomyDefTable> }
	| { success: false; error: { code: string; message: string } }
> {
	let query = db.selectFrom("_emdash_taxonomy_defs").selectAll().where("name", "=", name);
	if (locale !== undefined) query = query.where("locale", "=", locale);
	const def = await query.orderBy("locale", "asc").executeTakeFirst();
	if (!def) {
		return {
			success: false,
			error: { code: "NOT_FOUND", message: `Taxonomy '${name}' not found` },
		};
	}
	return { success: true, def };
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
		let query = db.selectFrom("_emdash_taxonomy_defs").selectAll();
		if (options.locale !== undefined) query = query.where("locale", "=", options.locale);
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
): Promise<ApiResult<{ taxonomy: TaxonomyDef }>> {
	try {
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
		if (collections.length > 0) {
			const existingCollections = await db
				.selectFrom("_emdash_collections")
				.select("slug")
				.where("slug", "in", collections)
				.execute();
			const existingSlugs = new Set(existingCollections.map((c) => c.slug));
			const invalid = collections.filter((c) => !existingSlugs.has(c));
			if (invalid.length > 0) {
				return {
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						message: `Unknown collection(s): ${invalid.join(", ")}`,
					},
				};
			}
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
		if (input.locale !== undefined) {
			const existing = await db
				.selectFrom("_emdash_taxonomy_defs")
				.select("id")
				.where("name", "=", input.name)
				.where("locale", "=", input.locale)
				.executeTakeFirst();
			if (existing) {
				return {
					success: false,
					error: {
						code: "CONFLICT",
						message: `Taxonomy '${input.name}' already exists in locale '${input.locale}'`,
					},
				};
			}
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
				...(input.locale !== undefined ? { locale: input.locale } : {}),
				translation_group: translationGroup ?? id,
			})
			.execute();

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
	options: { locale?: string } = {},
): Promise<ApiResult<TermListResponse>> {
	try {
		// Definitions are per-locale but terms aren't bound to the def's locale —
		// just ensure the taxonomy exists somewhere.
		const lookup = await requireTaxonomyDef(db, taxonomyName);
		if (!lookup.success) return lookup;

		const repo = new TaxonomyRepository(db);
		const terms = await repo.findByName(taxonomyName, { locale: options.locale });

		// Batch count entries per term in a single query (replaces N+1 pattern).
		// content_taxonomies.taxonomy_id stores the translation_group, so we
		// look up by group and map back to each term's id.
		const groups = terms.map((t) => t.translationGroup ?? t.id);
		const countsByGroup = await repo.countEntriesForTerms(groups);

		const termData: TermWithCount[] = terms.map((term) => ({
			id: term.id,
			name: term.name,
			slug: term.slug,
			label: term.label,
			parentId: term.parentId,
			description: typeof term.data?.description === "string" ? term.data.description : undefined,
			children: [],
			count: countsByGroup.get(term.translationGroup ?? term.id) ?? 0,
			locale: term.locale,
			translationGroup: term.translationGroup,
		}));

		const isHierarchical = lookup.def.hierarchical === 1;
		const result = isHierarchical ? buildTree(termData) : termData;
		return { success: true, data: { terms: result } };
	} catch {
		return {
			success: false,
			error: { code: "TERM_LIST_ERROR", message: "Failed to list terms" },
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
 *   - if `termId` is provided (update path), reject `parentId === termId`
 *     (self-parent) and walk up the parent chain to detect cycles.
 */
async function validateParentTerm(
	repo: TaxonomyRepository,
	taxonomyName: string,
	termId: string | undefined,
	parentId: string | null | undefined,
): Promise<{ code: "VALIDATION_ERROR"; message: string } | null> {
	if (parentId === undefined || parentId === null) return null;

	if (termId !== undefined && parentId === termId) {
		return {
			code: "VALIDATION_ERROR",
			message: "A term cannot be its own parent",
		};
	}

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
	const MAX_DEPTH = 100;
	let cursor: string | null = parent.parentId;
	let steps = 0;
	while (cursor !== null && steps < MAX_DEPTH) {
		if (termId !== undefined && cursor === termId) {
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
		slug: string;
		label: string;
		parentId?: string | null;
		description?: string;
		locale?: string;
		translationOf?: string;
	},
): Promise<ApiResult<TermResponse>> {
	try {
		// Taxonomy definitions are per-locale, but terms can exist in any locale
		// regardless of whether the def has been translated there. Look up the
		// def across all locales — we only care that it *exists*.
		const lookup = await requireTaxonomyDef(db, taxonomyName);
		if (!lookup.success) return lookup;

		const repo = new TaxonomyRepository(db);

		// Coerce empty-string parentId to undefined (treat as "no parent").
		let parentId =
			input.parentId === "" || input.parentId === undefined ? undefined : input.parentId;

		// Conflict check is scoped to locale (per-locale slugs are unique).
		const existing = await repo.findBySlug(taxonomyName, input.slug, input.locale);
		if (existing) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: input.locale
						? `Term '${input.slug}' already exists in '${taxonomyName}' (${input.locale})`
						: `Term with slug '${input.slug}' already exists in taxonomy '${taxonomyName}'`,
				},
			};
		}

		// If creating a translation whose parent is the translated sibling of
		// the source's parent, try to resolve the parent in the same locale.
		if (input.translationOf && parentId) {
			const source = await repo.findById(input.translationOf);
			if (source?.parentId === parentId && input.locale) {
				const sourceParent = await repo.findById(parentId);
				if (sourceParent?.translationGroup) {
					const translatedParent = await db
						.selectFrom("taxonomies")
						.select("id")
						.where("translation_group", "=", sourceParent.translationGroup)
						.where("locale", "=", input.locale)
						.executeTakeFirst();
					if (translatedParent) parentId = translatedParent.id;
				}
			}
		}

		// Validate parentId: must exist AND belong to the same taxonomy.
		// (Cycle check is N/A on create — the term doesn't exist yet.)
		const parentError = await validateParentTerm(repo, taxonomyName, undefined, parentId);
		if (parentError) {
			return { success: false, error: parentError };
		}

		const term = await repo.create({
			name: taxonomyName,
			slug: input.slug,
			label: input.label,
			parentId: parentId ?? undefined,
			data: input.description ? { description: input.description } : undefined,
			locale: input.locale,
			translationOf: input.translationOf,
		});

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
	} catch {
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
		const term = await repo.findBySlug(taxonomyName, termSlug, options.locale);

		if (!term) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Term '${termSlug}' not found in taxonomy '${taxonomyName}'`,
				},
			};
		}

		const count = await repo.countEntriesWithTerm(term.id);
		const children = await repo.findChildren(term.id);

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
		const term = await repo.findBySlug(taxonomyName, termSlug, options.locale);

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
			const existing = await repo.findBySlug(taxonomyName, newSlug, options.locale);
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
		const term = await repo.findBySlug(taxonomyName, termSlug, options.locale);

		if (!term) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Term '${termSlug}' not found in taxonomy '${taxonomyName}'`,
				},
			};
		}

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
