/**
 * Taxonomy and term CRUD handlers
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { TaxonomyRepository } from "../../database/repositories/taxonomy.js";
import type { Database } from "../../database/types.js";
import { invalidateTermCache } from "../../taxonomies/index.js";
import type { ApiResult } from "../types.js";

/** Taxonomy name validation pattern: lowercase alphanumeric + underscores, starts with letter */
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build tree structure from flat terms
 */
function buildTree(flatTerms: TermWithCount[]): TermWithCount[] {
	const map = new Map<string, TermWithCount>();
	const roots: TermWithCount[] = [];

	for (const term of flatTerms) {
		map.set(term.id, term);
	}

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
 * Look up a taxonomy definition by name, returning a NOT_FOUND error if missing.
 */
async function requireTaxonomyDef(
	db: Kysely<Database>,
	name: string,
): Promise<
	| { success: true; def: { hierarchical: number } }
	| { success: false; error: { code: string; message: string } }
> {
	const def = await db
		.selectFrom("_emdash_taxonomy_defs")
		.selectAll()
		.where("name", "=", name)
		.executeTakeFirst();

	if (!def) {
		return {
			success: false,
			error: { code: "NOT_FOUND", message: `Taxonomy '${name}' not found` },
		};
	}

	return { success: true, def };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * List all taxonomy definitions
 */
export async function handleTaxonomyList(
	db: Kysely<Database>,
): Promise<ApiResult<TaxonomyListResponse>> {
	try {
		const [rows, collectionRows] = await Promise.all([
			db.selectFrom("_emdash_taxonomy_defs").selectAll().execute(),
			db.selectFrom("_emdash_collections").select("slug").execute(),
		]);

		// Filter orphan collection references on read so the response stays
		// consistent with `schema_list_collections`. Storage is untouched —
		// re-creating the collection re-links automatically.
		const realCollections = new Set(collectionRows.map((r) => r.slug));

		const taxonomies: TaxonomyDef[] = rows.map((row) => {
			const stored: string[] = row.collections ? JSON.parse(row.collections) : [];
			return {
				id: row.id,
				name: row.name,
				label: row.label,
				labelSingular: row.label_singular ?? undefined,
				hierarchical: row.hierarchical === 1,
				collections: stored.filter((slug) => realCollections.has(slug)),
			};
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
	input: { name: string; label: string; hierarchical?: boolean; collections?: string[] },
): Promise<ApiResult<{ taxonomy: TaxonomyDef }>> {
	try {
		// Validate name format
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

		// Validate that referenced collections exist
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

		// Check for duplicate name
		const existing = await db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where("name", "=", input.name)
			.executeTakeFirst();

		if (existing) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: `Taxonomy '${input.name}' already exists`,
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
				label_singular: null,
				hierarchical: input.hierarchical ? 1 : 0,
				collections: JSON.stringify(collections),
			})
			.execute();

		return {
			success: true,
			data: {
				taxonomy: {
					id,
					name: input.name,
					label: input.label,
					hierarchical: input.hierarchical ?? false,
					collections,
				},
			},
		};
	} catch (error) {
		// Handle UNIQUE constraint violation from concurrent duplicate inserts
		if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: `Taxonomy '${input.name}' already exists`,
				},
			};
		}
		return {
			success: false,
			error: { code: "TAXONOMY_CREATE_ERROR", message: "Failed to create taxonomy" },
		};
	}
}

/**
 * List all terms for a taxonomy (returns tree for hierarchical taxonomies)
 */
export async function handleTermList(
	db: Kysely<Database>,
	taxonomyName: string,
): Promise<ApiResult<TermListResponse>> {
	try {
		const lookup = await requireTaxonomyDef(db, taxonomyName);
		if (!lookup.success) return lookup;

		const repo = new TaxonomyRepository(db);
		const terms = await repo.findByName(taxonomyName);

		// Get counts for each term
		const counts = new Map<string, number>();
		for (const term of terms) {
			const count = await repo.countEntriesWithTerm(term.id);
			counts.set(term.id, count);
		}

		const termData: TermWithCount[] = terms.map((term) => ({
			id: term.id,
			name: term.name,
			slug: term.slug,
			label: term.label,
			parentId: term.parentId,
			description: typeof term.data?.description === "string" ? term.data.description : undefined,
			children: [],
			count: counts.get(term.id) ?? 0,
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
 * Create a new term in a taxonomy
 */
export async function handleTermCreate(
	db: Kysely<Database>,
	taxonomyName: string,
	input: { slug: string; label: string; parentId?: string | null; description?: string },
): Promise<ApiResult<TermResponse>> {
	try {
		const lookup = await requireTaxonomyDef(db, taxonomyName);
		if (!lookup.success) return lookup;

		const repo = new TaxonomyRepository(db);

		// Check for slug conflict
		const existing = await repo.findBySlug(taxonomyName, input.slug);
		if (existing) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: `Term with slug '${input.slug}' already exists in taxonomy '${taxonomyName}'`,
				},
			};
		}

		const term = await repo.create({
			name: taxonomyName,
			slug: input.slug,
			label: input.label,
			parentId: input.parentId ?? undefined,
			data: input.description ? { description: input.description } : undefined,
		});

		// New term means `hasAnyTermAssignments` may flip from false->true next
		// time an entry is tagged. Clear the cache so the next read re-probes.
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
): Promise<ApiResult<TermGetResponse>> {
	try {
		const repo = new TaxonomyRepository(db);
		const term = await repo.findBySlug(taxonomyName, termSlug);

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
					children: children.map((c) => ({
						id: c.id,
						slug: c.slug,
						label: c.label,
					})),
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

/**
 * Update a term
 */
export async function handleTermUpdate(
	db: Kysely<Database>,
	taxonomyName: string,
	termSlug: string,
	input: { slug?: string; label?: string; parentId?: string | null; description?: string },
): Promise<ApiResult<TermResponse>> {
	try {
		const repo = new TaxonomyRepository(db);
		const term = await repo.findBySlug(taxonomyName, termSlug);

		if (!term) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Term '${termSlug}' not found in taxonomy '${taxonomyName}'`,
				},
			};
		}

		// Check if new slug conflicts
		if (input.slug && input.slug !== termSlug) {
			const existing = await repo.findBySlug(taxonomyName, input.slug);
			if (existing && existing.id !== term.id) {
				return {
					success: false,
					error: {
						code: "CONFLICT",
						message: `Term with slug '${input.slug}' already exists in taxonomy '${taxonomyName}'`,
					},
				};
			}
		}

		const updated = await repo.update(term.id, {
			slug: input.slug,
			label: input.label,
			parentId: input.parentId,
			data: input.description !== undefined ? { description: input.description } : undefined,
		});

		// Term label/slug changes are reflected in hydrated entry.data.terms —
		// invalidate so the next read doesn't short-circuit on a stale probe.
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
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const repo = new TaxonomyRepository(db);
		const term = await repo.findBySlug(taxonomyName, termSlug);

		if (!term) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Term '${termSlug}' not found in taxonomy '${taxonomyName}'`,
				},
			};
		}

		// Prevent deletion of terms with children
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

		// Deleting a term cascades to content_taxonomies; invalidate so
		// hydration no longer sees the stale assignments.
		invalidateTermCache();

		return { success: true, data: { deleted: true } };
	} catch {
		return {
			success: false,
			error: { code: "TERM_DELETE_ERROR", message: "Failed to delete term" },
		};
	}
}
