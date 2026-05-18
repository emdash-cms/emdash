/**
 * WXR taxonomy import helpers.
 *
 * Bridges parsed WordPress taxonomy data (`WxrCategory`, `WxrTag`, `WxrTerm`,
 * and per-item `WxrPost.categories` / `WxrPost.tags` / `WxrPost.customTaxonomies`)
 * onto EmDash's term + content_taxonomies tables.
 *
 * Why this isn't inline in `execute.ts`: pre-creating all terms before any
 * post is created lets us (a) build a lookup once for every (taxonomy, slug)
 * the import needs, and (b) keep the per-post attachment loop cheap. It also
 * makes the logic testable without spinning up an Astro request.
 *
 * Behaviour:
 *   - `wp:category` -> EmDash `category` taxonomy (seeded by migration 006).
 *   - `wp:tag`      -> EmDash `tag` taxonomy.
 *   - `wp:term`     -> matching EmDash taxonomy by `name` (case-sensitive).
 *                      If no matching def exists in the target locale, the
 *                      term is skipped — we don't auto-create defs because
 *                      the user controls their schema through the admin.
 *   - Terms are created idempotently by `(taxonomy, slug, locale)`. Existing
 *     terms are reused.
 *   - Assignments respect the def's `collections` array. If the post's target
 *     collection isn't listed on the taxonomy def, the assignment is skipped
 *     (matches admin UI behaviour: you can't tag a "products" post with a
 *     "category" if `category.collections` only includes "posts").
 */

import type { Kysely } from "kysely";

import type { WxrCategory, WxrPost, WxrTag, WxrTerm } from "../cli/wxr/parser.js";
import { TaxonomyRepository } from "../database/repositories/taxonomy.js";
import type { Database } from "../database/types.js";
import { resolveLocaleChain } from "../i18n/resolve.js";
import { invalidateTermCache } from "../taxonomies/index.js";

/**
 * Thrown by `mirrorTermsToLocales` when a pre-existing locale row at the
 * same `(taxonomy, slug)` belongs to a different `translation_group` than
 * the canonical term. Callers in the route layer surface
 * `publicMessage` to the operator (no internal data) while logging
 * `cause` server-side.
 *
 * Marker class so the route layer can distinguish "operator-actionable
 * taxonomy conflict" from any other DB / repository error that might
 * escape the helper.
 */
export class WxrTaxonomyConflictError extends Error {
	readonly publicMessage: string;
	constructor(publicMessage: string, options?: { cause?: unknown }) {
		super(publicMessage, options);
		this.name = "WxrTaxonomyConflictError";
		this.publicMessage = publicMessage;
	}
}

export function isWxrTaxonomyConflictError(error: unknown): error is WxrTaxonomyConflictError {
	return error instanceof WxrTaxonomyConflictError;
}

/**
 * Result of pre-importing taxonomy terms from a WXR file.
 */
export interface TaxonomyImportPlan {
	/** terms created during this run (per taxonomy name) */
	termsCreated: Record<string, number>;
	/** terms that already existed and were reused (per taxonomy name) */
	termsReused: Record<string, number>;
	/** custom taxonomies (`wp:term`) skipped because no matching EmDash def exists */
	missingTaxonomies: string[];
	/**
	 * Lookup table: `taxonomy name` -> `term slug` -> term id.
	 * Used by `attachPostTaxonomies` to translate WXR assignments into pivot rows.
	 */
	termIdByNameAndSlug: Map<string, Map<string, string>>;
	/**
	 * Lookup table: `taxonomy name` -> set of collection slugs the def allows.
	 * Empty (or missing) means "any collection" — we only enforce the filter
	 * when the def explicitly lists collections.
	 */
	collectionsByTaxonomy: Map<string, Set<string>>;
	/**
	 * Lookup table: `term id` -> the term's `translation_group` (or `null`
	 * if the term doesn't exist any more). Populated lazily by helpers that
	 * need to check pivot existence without repeating per-term DB reads.
	 */
	translationGroupByTermId: Map<string, string | null>;
}

/**
 * Track running counts plus the lookup maps.
 */
interface TaxonomyImportState {
	plan: TaxonomyImportPlan;
}

function makeState(): TaxonomyImportState {
	return {
		plan: {
			termsCreated: {},
			termsReused: {},
			missingTaxonomies: [],
			termIdByNameAndSlug: new Map(),
			collectionsByTaxonomy: new Map(),
			translationGroupByTermId: new Map(),
		},
	};
}

/**
 * Record-keeping helpers — keep mutations centralised so the result object
 * stays consistent.
 */
function bump(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
}

function rememberTerm(
	state: TaxonomyImportState,
	taxonomyName: string,
	slug: string,
	termId: string,
): void {
	let bySlug = state.plan.termIdByNameAndSlug.get(taxonomyName);
	if (!bySlug) {
		bySlug = new Map();
		state.plan.termIdByNameAndSlug.set(taxonomyName, bySlug);
	}
	bySlug.set(slug, termId);
}

/**
 * Look up an EmDash taxonomy def by name. Definitions are per-locale but
 * a def is conceptually site-wide -- the per-locale row carries only the
 * label translations.
 *
 * Match the runtime helper `getTaxonomyDef` (in `src/taxonomies/index.ts`):
 * walk `resolveLocaleChain(locale)` so the importer picks the same def the
 * runtime would later resolve to. When the chain is empty (i18n disabled)
 * or every locale in the chain misses, fall through to the lowest-locale
 * row so single-locale installs still see seeded defs that were inserted
 * at some non-empty locale value.
 *
 * Without this fallback, a user importing into a non-default locale would
 * see every category dropped as `missingTaxonomies` even though the seeded
 * defs exist (just at the site's default locale).
 */
function parseDefCollections(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.filter((c): c is string => typeof c === "string");
		}
	} catch {
		// malformed JSON in the def -- treat as "no collection filter"
	}
	return [];
}

async function findTaxonomyDef(
	db: Kysely<Database>,
	name: string,
	locale: string | undefined,
): Promise<{ id: string; collections: string[] } | null> {
	const chain = resolveLocaleChain(locale);

	if (chain.length === 0) {
		// i18n disabled and no explicit locale. The runtime treats this
		// as "no locale filter" and picks the lowest-locale row. We do the
		// same so the importer agrees with how the runtime later reads
		// the def.
		const row = await db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where("name", "=", name)
			.orderBy("locale", "asc")
			.executeTakeFirst();
		return row ? { id: row.id, collections: parseDefCollections(row.collections) } : null;
	}

	// Non-empty chain: walk it in order, return null if every entry misses.
	// This matches `getTaxonomyDef` exactly. We deliberately do NOT fall
	// through to any-locale lookup: doing so would let the importer pick a
	// def at a locale the runtime would never resolve to, producing
	// content the user can't see in the admin or on the rendered site.
	for (const tryLocale of chain) {
		const row = await db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where("name", "=", name)
			.where("locale", "=", tryLocale)
			.executeTakeFirst();
		if (row) {
			return { id: row.id, collections: parseDefCollections(row.collections) };
		}
	}

	return null;
}

/**
 * Find or create a term in the given taxonomy. Returns the term id. Callers
 * must verify the taxonomy def exists before calling — this helper assumes
 * the def is present.
 *
 * Note: we don't resolve WordPress parent slugs into EmDash parent ids in
 * this pass. WXR exports list categories in arbitrary order, so a category's
 * parent may not exist yet when we first see it. Hierarchy is preserved at
 * the data level (the parent slug is on `WxrCategory.parent`) but flattens
 * in EmDash for now; restoring the tree is a follow-up improvement.
 */
async function ensureTerm(
	repo: TaxonomyRepository,
	state: TaxonomyImportState,
	taxonomyName: string,
	slug: string,
	label: string,
	description: string | undefined,
	locale: string | undefined,
): Promise<string> {
	// Already resolved in this run (e.g. seen in `wp:category` AND in a per-
	// item `<category>` element).
	const cached = state.plan.termIdByNameAndSlug.get(taxonomyName)?.get(slug);
	if (cached) return cached;

	const existing = await repo.findBySlug(taxonomyName, slug, locale);
	if (existing) {
		bump(state.plan.termsReused, taxonomyName);
		rememberTerm(state, taxonomyName, slug, existing.id);
		return existing.id;
	}

	// No row at the requested locale. Before creating, check whether a
	// `(name, slug)` row exists in some OTHER locale -- e.g. the admin
	// pre-created an Arabic translation, and now an `en` import wants the
	// canonical row. We need to mint the new row inside the existing row's
	// `translation_group` so per-locale lookups across the family work.
	// Without this, the mirror pass would later refuse to reconcile (it
	// sees pre-existing rows in a different group as a no-op) and pivots
	// would point at a group that has no row in the requested locale.
	const anyLocale = await repo.findBySlug(taxonomyName, slug);
	const translationOf = anyLocale?.id;

	const created = await repo.create({
		name: taxonomyName,
		slug,
		label,
		data: description ? { description } : undefined,
		locale,
		translationOf,
	});
	bump(state.plan.termsCreated, taxonomyName);
	rememberTerm(state, taxonomyName, slug, created.id);
	return created.id;
}

/**
 * Retrieve the human label captured by the parser for a per-item
 * `<category>` text body, falling back to the slug when the parser didn't
 * see a label (e.g. self-closing tags or whitespace-only bodies).
 */
function labelFor(post: WxrPost, taxonomy: string, slug: string): string {
	const key = `${taxonomy}\u0000${slug}`;
	return post.taxonomyLabels?.get(key) ?? slug;
}

/**
 * Pre-import every term referenced by the WXR file.
 *
 * Pass 1: `wp:category` blocks. Each becomes a term in EmDash's seeded
 *         `category` taxonomy.
 * Pass 2: `wp:tag` blocks. Each becomes a term in `tag`.
 * Pass 3: `wp:term` blocks (custom taxonomies). Skipped when no matching
 *         EmDash def exists.
 * Pass 4: per-item `<category domain="…" nicename="…">` assignments. WXR
 *         exports sometimes reference taxonomies/terms that weren't declared
 *         at the top level (older exports especially), so we backfill terms
 *         from per-item assignments. Categories and tags use the seeded defs
 *         and pick up the assignment text as the label; custom domains fall
 *         back to the same "def must exist" rule.
 */
export async function preImportWxrTaxonomies(
	db: Kysely<Database>,
	posts: WxrPost[],
	categories: WxrCategory[],
	tags: WxrTag[],
	terms: WxrTerm[],
	locale: string | undefined,
): Promise<TaxonomyImportPlan> {
	const state = makeState();
	const repo = new TaxonomyRepository(db);

	// Cache def lookups for the duration of the import. Keyed by name; value
	// is `null` when we've already determined the def is missing in this
	// locale (so we only report the "missing" warning once per taxonomy).
	const defCache = new Map<string, { id: string; collections: string[] } | null>();
	const lookupDef = async (name: string): Promise<{ id: string; collections: string[] } | null> => {
		if (defCache.has(name)) return defCache.get(name) ?? null;
		const def = await findTaxonomyDef(db, name, locale);
		defCache.set(name, def);
		if (def) {
			state.plan.collectionsByTaxonomy.set(name, new Set(def.collections));
		}
		return def;
	};

	// Pass 1: top-level <wp:category> blocks -> EmDash `category` taxonomy.
	const categoryDef = await lookupDef("category");
	if (categoryDef) {
		for (const cat of categories) {
			const slug = cat.nicename;
			const label = cat.name;
			if (!slug || !label) continue;
			await ensureTerm(repo, state, "category", slug, label, cat.description, locale);
		}
	} else if (categories.length > 0) {
		// Seeded `category` def was deleted by the user — record so the
		// import response can surface why none of the categories landed.
		state.plan.missingTaxonomies.push("category");
	}

	// Pass 2: top-level <wp:tag> blocks -> EmDash `tag` taxonomy.
	const tagDef = await lookupDef("tag");
	if (tagDef) {
		for (const tag of tags) {
			const slug = tag.slug;
			const label = tag.name;
			if (!slug || !label) continue;
			await ensureTerm(repo, state, "tag", slug, label, tag.description, locale);
		}
	} else if (tags.length > 0) {
		state.plan.missingTaxonomies.push("tag");
	}

	// Pass 3: <wp:term> blocks for custom taxonomies (genre, etc.). Skipped:
	//   - `nav_menu`: menus are handled by `importMenusFromWxr`.
	//   - `language`: Polylang's locale signal; promoted to `WxrPost.locale`
	//     by the parser and not a content taxonomy in EmDash.
	for (const term of terms) {
		if (term.taxonomy === "nav_menu" || term.taxonomy === "language") continue;
		// Normalize WordPress' `post_tag` synonym -> EmDash `tag`. WordPress
		// emits `<wp:tag>` for some exports and `<wp:term wp:term_taxonomy="post_tag">`
		// for others; both must land in the same EmDash taxonomy.
		const taxonomyName = term.taxonomy === "post_tag" ? "tag" : term.taxonomy;
		const def = await lookupDef(taxonomyName);
		if (!def) {
			if (!state.plan.missingTaxonomies.includes(taxonomyName)) {
				state.plan.missingTaxonomies.push(taxonomyName);
			}
			continue;
		}
		await ensureTerm(repo, state, taxonomyName, term.slug, term.name, term.description, locale);
	}

	// Pass 4: per-item assignments. Backfills terms missing from the top-
	// level blocks (rare, but observed in hand-edited or partial exports).
	// Labels come from the per-item `<category>` text body when the parser
	// captured one; otherwise we fall back to the slug. This is the path
	// for older exports that skip top-level `<wp:category>` definitions.
	let recordedMissingCategoryFromPosts = false;
	let recordedMissingTagFromPosts = false;
	for (const post of posts) {
		for (const slug of post.categories) {
			if (!categoryDef) {
				if (
					!recordedMissingCategoryFromPosts &&
					!state.plan.missingTaxonomies.includes("category")
				) {
					state.plan.missingTaxonomies.push("category");
					recordedMissingCategoryFromPosts = true;
				}
				break;
			}
			if (state.plan.termIdByNameAndSlug.get("category")?.has(slug)) continue;
			await ensureTerm(
				repo,
				state,
				"category",
				slug,
				labelFor(post, "category", slug),
				undefined,
				locale,
			);
		}
		for (const slug of post.tags) {
			if (!tagDef) {
				if (!recordedMissingTagFromPosts && !state.plan.missingTaxonomies.includes("tag")) {
					state.plan.missingTaxonomies.push("tag");
					recordedMissingTagFromPosts = true;
				}
				break;
			}
			if (state.plan.termIdByNameAndSlug.get("tag")?.has(slug)) continue;
			await ensureTerm(repo, state, "tag", slug, labelFor(post, "tag", slug), undefined, locale);
		}
		if (post.customTaxonomies) {
			for (const [rawName, slugs] of post.customTaxonomies) {
				// `nav_menu` is handled by the menu importer; `language` is
				// Polylang's per-post locale signal, already promoted by the
				// parser.
				if (rawName === "nav_menu" || rawName === "language") continue;
				const taxonomyName = rawName === "post_tag" ? "tag" : rawName;
				const def = await lookupDef(taxonomyName);
				if (!def) {
					if (!state.plan.missingTaxonomies.includes(taxonomyName)) {
						state.plan.missingTaxonomies.push(taxonomyName);
					}
					continue;
				}
				for (const slug of slugs) {
					if (state.plan.termIdByNameAndSlug.get(taxonomyName)?.has(slug)) continue;
					await ensureTerm(
						repo,
						state,
						taxonomyName,
						slug,
						labelFor(post, taxonomyName, slug),
						undefined,
						locale,
					);
				}
			}
		}
	}

	// `content_taxonomies` writes happen later in `attachPostTaxonomies`, but
	// term inserts above already invalidate the in-memory "has any terms" probe.
	// We flush once at the end of the pre-import to keep the runtime cache hot.
	invalidateTermCache();

	return state.plan;
}

/**
 * Walk a parsed WXR post's per-item taxonomy assignments and return only
 * the ones that resolve to a real EmDash term AND aren't filtered out by
 * the taxonomy def's `collections` allowlist. Grouped by EmDash taxonomy
 * name (so `post_tag` is already folded into `tag`). Deduplicated.
 *
 * This is the single source of truth for "what will the importer try to
 * write for this post". Both the anchor (additive `attachToEntry`) and
 * translation (per-taxonomy `setTermsForEntry`) paths drive from this map
 * so they agree on which taxonomies need touching. In particular, the
 * translation path uses the keys here -- not `postAssignedTaxonomies` --
 * to decide which inherited pivot rows to clear, so a translation whose
 * only assignment is filtered out by `collections` doesn't lose its
 * inherited terms (see #1087 review feedback).
 *
 * Skipped taxonomies: `nav_menu` (handled by the menu importer) and
 * `language` (Polylang's locale signal, already promoted to `post.locale`
 * by the parser).
 */
export function resolvePostTermAssignments(
	collection: string,
	post: WxrPost,
	plan: TaxonomyImportPlan,
): Map<string, string[]> {
	const result = new Map<string, string[]>();
	const seen = new Set<string>();

	const tryResolve = (taxonomyName: string, slug: string): void => {
		const termId = plan.termIdByNameAndSlug.get(taxonomyName)?.get(slug);
		if (!termId) return;
		const collectionFilter = plan.collectionsByTaxonomy.get(taxonomyName);
		// Empty set means "no filter" (def has no collections array). A
		// non-empty set is enforced: skip assignments to collections the
		// def doesn't list. Matches admin UI: a `category` term linked
		// only to `posts` shouldn't end up on a `products` row just
		// because the WXR happened to mention it.
		if (collectionFilter && collectionFilter.size > 0 && !collectionFilter.has(collection)) {
			return;
		}
		const dedupeKey = `${taxonomyName}\u0000${termId}`;
		if (seen.has(dedupeKey)) return;
		seen.add(dedupeKey);
		const existing = result.get(taxonomyName);
		if (existing) existing.push(termId);
		else result.set(taxonomyName, [termId]);
	};

	for (const slug of post.categories) tryResolve("category", slug);
	for (const slug of post.tags) tryResolve("tag", slug);
	if (post.customTaxonomies) {
		for (const [rawName, slugs] of post.customTaxonomies) {
			if (rawName === "nav_menu" || rawName === "language") continue;
			const taxonomyName = rawName === "post_tag" ? "tag" : rawName;
			for (const slug of slugs) tryResolve(taxonomyName, slug);
		}
	}

	return result;
}

/**
 * Attach the taxonomy assignments parsed for a single WXR post to a freshly-
 * created EmDash content row. Additive (`attachToEntry` + `ON CONFLICT DO
 * NOTHING`). Used for anchors -- translations need replace-semantics per
 * taxonomy and should use `setPostTermAssignmentsReplacing` instead.
 *
 * Returns the number of pivot rows actually inserted (excludes rows that
 * already existed via the `ON CONFLICT DO NOTHING` path), so the caller can
 * roll them up into the import summary without over-counting on re-imports.
 */
export async function attachPostTaxonomies(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	post: WxrPost,
	plan: TaxonomyImportPlan,
): Promise<number> {
	const repo = new TaxonomyRepository(db);
	const resolved = resolvePostTermAssignments(collection, post, plan);

	let attached = 0;
	for (const [, termIds] of resolved) {
		for (const termId of termIds) {
			const wrote = await attachToEntryCountingInserts(db, repo, plan, collection, entryId, termId);
			if (wrote) attached++;
		}
	}
	return attached;
}

/**
 * Replace assignments per-taxonomy from a parsed WXR post. Used for
 * translations: WPML's "Translate Independently" mode lets translators
 * override term assignments per-taxonomy, not per-post. A translation that
 * overrides `category` shouldn't lose its inherited `tag` or `genre`. We
 * only call `setTermsForEntry(name, ids)` for taxonomies where the
 * translation actually resolved at least one term -- taxonomies with no
 * resolvable+permitted terms are left alone so inherited rows from
 * `copyEntryTerms` stay intact.
 *
 * Returns the number of pivot rows after replacement (sum of `termIds`
 * lists across taxonomies actually touched). Note this counts logical
 * assignments, not the delta from the prior state; the import summary
 * treats this as an additive count for compatibility with `attachPost-
 * Taxonomies`.
 */
export async function setPostTermAssignmentsReplacing(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	post: WxrPost,
	plan: TaxonomyImportPlan,
): Promise<number> {
	const repo = new TaxonomyRepository(db);
	const resolved = resolvePostTermAssignments(collection, post, plan);

	let attached = 0;
	for (const [taxonomyName, termIds] of resolved) {
		await repo.setTermsForEntry(collection, entryId, taxonomyName, termIds);
		attached += termIds.length;
	}
	return attached;
}

/**
 * Resolve a term id to its `translation_group` (the value
 * `content_taxonomies` stores). Caches the result on the plan so
 * repeated attaches of the same term don't repeat the lookup.
 */
async function termTranslationGroup(
	repo: TaxonomyRepository,
	plan: TaxonomyImportPlan,
	termId: string,
): Promise<string | null> {
	const cached = plan.translationGroupByTermId.get(termId);
	if (cached !== undefined) return cached;
	const term = await repo.findById(termId);
	const group = term?.translationGroup ?? null;
	plan.translationGroupByTermId.set(termId, group);
	return group;
}

/**
 * Wrapper around `TaxonomyRepository.attachToEntry` that returns whether
 * an actual row was inserted (vs. silently skipped by the `ON CONFLICT DO
 * NOTHING` branch). Lets the importer's `assignments` counter reflect real
 * writes rather than re-import no-ops.
 *
 * Best-effort: we check pivot existence first, then call `attachToEntry`.
 * A concurrent insert between the check and the attach would make us
 * report `false` while a row was in fact inserted -- the count is for
 * summary display only, never correctness.
 */
async function attachToEntryCountingInserts(
	db: Kysely<Database>,
	repo: TaxonomyRepository,
	plan: TaxonomyImportPlan,
	collection: string,
	entryId: string,
	termId: string,
): Promise<boolean> {
	const group = await termTranslationGroup(repo, plan, termId);
	if (!group) return false;

	const existing = await db
		.selectFrom("content_taxonomies")
		.select("collection")
		.where("collection", "=", collection)
		.where("entry_id", "=", entryId)
		.where("taxonomy_id", "=", group)
		.executeTakeFirst();
	if (existing) return false;

	await repo.attachToEntry(collection, entryId, termId);
	return true;
}

/**
 * Mirror every term in the plan into each additional locale used by the
 * incoming posts. New rows share the canonical term's `translation_group`
 * so per-locale lookups (`getTermsForEntry(..., locale)`) resolve correctly
 * for translations whose locale differs from the import-wide one.
 *
 * Without this pass, multilingual WXR imports (#1080) write all term rows
 * at the upload-wide locale; the `content_taxonomies` pivot is correct (it
 * stores `translation_group`, not `term id`), but
 * `getTermsForEntry(collection, arabicPostId, "category", "ar")` filters on
 * `taxonomies.locale = "ar"` and returns zero rows. Users see "no tags" on
 * every non-canonical translation.
 *
 * Idempotent: skips a locale when a row already exists at `(name, slug,
 * locale)`. Safe to call after `preImportWxrTaxonomies` on subsequent
 * imports.
 */
export async function mirrorTermsToLocales(
	db: Kysely<Database>,
	plan: TaxonomyImportPlan,
	postLocales: Iterable<string>,
	canonicalLocale: string | undefined,
): Promise<void> {
	const localeSet = new Set<string>();
	for (const locale of postLocales) {
		if (!locale || locale === canonicalLocale) continue;
		localeSet.add(locale);
	}
	if (localeSet.size === 0) return;

	const repo = new TaxonomyRepository(db);

	for (const [taxonomyName, bySlug] of plan.termIdByNameAndSlug) {
		for (const [slug, canonicalTermId] of bySlug) {
			// Resolve the canonical's translation_group once; we'll compare
			// against any pre-existing rows we find at the target locales.
			// Cache on the plan so subsequent attaches (which also need
			// this resolution) don't repeat the lookup.
			const cachedGroup = await termTranslationGroup(repo, plan, canonicalTermId);
			if (!cachedGroup) {
				// The canonical term id is in the plan but the row is no
				// longer in the DB. Shouldn't happen during a single
				// import run; skip rather than crash so the rest of the
				// import can complete.
				continue;
			}
			const canonicalGroup = cachedGroup;

			for (const locale of localeSet) {
				const existing = await repo.findBySlug(taxonomyName, slug, locale);
				if (existing) {
					// `ensureTerm` resolves cross-locale grouping when it
					// creates the canonical row, so a pre-existing sibling
					// row at this locale should already share the
					// canonical's `translation_group`. If it doesn't, the
					// import would write pivots pointing at a group that
					// has no row in this locale -- a silent data-integrity
					// bug. Fail closed: throw so the operator reconciles
					// the existing rows in the admin before retrying. This
					// happens when the canonical row was created in an
					// earlier import and a sibling-locale row was added
					// manually afterwards (or vice versa) without linking
					// them via translationOf.
					if (existing.translationGroup !== canonicalGroup) {
						throw new WxrTaxonomyConflictError(
							`Cannot import: term "${taxonomyName}/${slug}" already exists at locale "${locale}" in a different translation group than the canonical row at this import's locale. Reconcile the rows in the admin (re-link via translationOf, or delete one) and retry.`,
						);
					}
					continue;
				}
				try {
					await repo.create({
						name: taxonomyName,
						slug,
						label: slug, // we don't have a per-locale label from the WXR
						locale,
						translationOf: canonicalTermId,
					});
				} catch (error) {
					// `findBySlug` + `create` is not atomic. A concurrent
					// import racing us into the same `(name, slug, locale)`
					// will trip the UNIQUE constraint. Re-read the row that
					// won the race and verify its `translation_group`
					// matches the canonical's; if not, the pivot will
					// resolve to a group that has no row in this locale
					// (silent data-integrity bug) so we surface that loudly
					// rather than continue.
					//
					// Other errors (validation, connectivity) re-throw so
					// the import fails closed rather than silently shipping
					// translations that resolve to empty taxonomy queries.
					const message = error instanceof Error ? error.message.toLowerCase() : "";
					const isUniqueRace =
						message.includes("unique constraint failed") || message.includes("duplicate key");
					if (!isUniqueRace) throw error;

					const winner = await repo.findBySlug(taxonomyName, slug, locale);
					if (!winner) {
						// UNIQUE conflict but no row visible? Shouldn't
						// happen unless the racing transaction rolled back;
						// fail loudly so the operator can investigate.
						throw new WxrTaxonomyConflictError(
							`Cannot import: term "${taxonomyName}/${slug}" raced UNIQUE at locale "${locale}" but no row is visible afterwards. The concurrent transaction may have rolled back; retry the import.`,
							{ cause: error },
						);
					}
					if (winner.translationGroup !== canonicalGroup) {
						throw new WxrTaxonomyConflictError(
							`Cannot import: term "${taxonomyName}/${slug}" raced UNIQUE at locale "${locale}" with a different translation group. Reconcile the rows in the admin and retry.`,
							{ cause: error },
						);
					}
					console.warn(
						`[WXR import] concurrent writer beat us to term "${taxonomyName}/${slug}" at locale "${locale}"; using existing row (same group).`,
					);
				}
			}
		}
	}
}
