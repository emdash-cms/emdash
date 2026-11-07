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
 *                      If the taxonomy isn't defined in any locale, the
 *                      term is skipped — we don't auto-create defs because
 *                      the user controls their schema through the admin.
 *   - Terms are created idempotently by `(taxonomy, slug, locale)`. Existing
 *     terms are reused.
 *   - Polylang records each term's language and translations in a
 *     `term_translations` term. Such terms are created in their own locale and
 *     linked to their translations, and the mirror pass leaves them alone.
 *   - Assignments respect the def's `collections` array. If the post's target
 *     collection isn't listed on the taxonomy def, the assignment is skipped
 *     (matches admin UI behaviour: you can't tag a "products" post with a
 *     "category" if `category.collections` only includes "posts").
 */

import type { Kysely } from "kysely";

import type { WxrCategory, WxrPost, WxrTag, WxrTerm } from "../cli/wxr/parser.js";
import { parsePolylangTranslations } from "../cli/wxr/parser.js";
import {
	findTaxonomyStructure,
	selectTaxonomyDefs,
} from "../database/repositories/taxonomy-def.js";
import { TaxonomyRepository } from "../database/repositories/taxonomy.js";
import type { Database } from "../database/types.js";
import { localeMatches, localeOrder } from "../i18n/query.js";
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
	/**
	 * Lookup table: `taxonomy name`, `term slug` and locale -> term id, keyed
	 * by `localizedTermKey`. Resolves a post's terms in the post's own locale
	 * first, so translations that share a slug don't collide.
	 */
	termIdByNameSlugAndLocale: Map<string, string>;
	/**
	 * Terms whose locale the export recorded (Polylang). They already exist
	 * in each locale they have, so `mirrorTermsToLocales` skips them.
	 */
	localizedTermIds: Set<string>;
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
			termIdByNameSlugAndLocale: new Map(),
			localizedTermIds: new Set(),
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

function localizedTermKey(taxonomyName: string, slug: string, locale: string): string {
	return `${taxonomyName}\u0000${slug}\u0000${locale}`;
}

/**
 * Taxonomies that WordPress plugins use for their own bookkeeping rather than
 * for content: menus, and Polylang's languages and translation groups.
 */
const INTERNAL_TAXONOMIES = new Set([
	"nav_menu",
	"language",
	"term_language",
	"post_translations",
	"term_translations",
]);

/**
 * Read the locale and translation group of every term that Polylang's
 * `term_translations` terms list, keyed by WordPress term id. Each of those
 * terms' descriptions holds a serialized `{ lang_code => term_id }` map.
 */
function polylangTermLocales(terms: WxrTerm[]): Map<number, { locale: string; group: string }> {
	const result = new Map<number, { locale: string; group: string }>();
	for (const term of terms) {
		if (term.taxonomy !== "term_translations" || !term.description) continue;
		for (const [locale, id] of parsePolylangTranslations(term.description)) {
			result.set(id, { locale, group: term.slug });
		}
	}
	return result;
}

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

/**
 * Rebuild the taxonomy lookup maps from the database without creating
 * anything. The chunked WP import runs term creation once (first content
 * chunk); every later chunk only needs the maps to attach per-post
 * assignments, and two SELECTs are far cheaper than re-walking every term
 * through the ensure path.
 *
 * ponytail: first row wins per (name, slug), ordered by locale asc — the
 * same row `findBySlug` without a locale resolves to. Per-locale term
 * variants beyond that are the mirror pass's job, not the importer's.
 */
export async function loadTaxonomyPlanFromDb(db: Kysely<Database>): Promise<TaxonomyImportPlan> {
	const state = makeState();

	const defs = await selectTaxonomyDefs(db).orderBy("d.locale", "asc").execute();
	for (const def of defs) {
		if (!state.plan.collectionsByTaxonomy.has(def.name)) {
			state.plan.collectionsByTaxonomy.set(def.name, new Set(parseDefCollections(def.collections)));
		}
	}

	const terms = await db
		.selectFrom("taxonomies")
		.select(["name", "slug", "id", "locale"])
		.orderBy("locale", "asc")
		.execute();
	for (const term of terms) {
		if (!state.plan.termIdByNameAndSlug.get(term.name)?.has(term.slug)) {
			rememberTerm(state, term.name, term.slug, term.id);
		}
		state.plan.termIdByNameSlugAndLocale.set(
			localizedTermKey(term.name, term.slug, term.locale),
			term.id,
		);
	}

	return state.plan;
}

interface TermDescriptor {
	taxonomyName: string;
	slug: string;
	label: string;
	description?: string;
	/** The term's own locale, when the export records it (Polylang) */
	locale?: string;
	/** Shared by the term's translations, when the export records them */
	translationKey?: string;
}

function termKey(taxonomyName: string, slug: string): string {
	return `${taxonomyName}\u0000${slug}`;
}

/**
 * Find or create many terms in a small number of batched SELECTs instead of
 * one SELECT per term. This is the dominant fixed cost for WXR imports with
 * large category/tag vocabularies: a site with 100+ categories would otherwise
 * spend one D1 round-trip per category before writing any posts.
 *
 * Batching rules:
 *   - Descriptors already resolved in `state.plan.termIdByNameAndSlug` are
 *     skipped (same idempotency as the old per-term loop).
 *   - Remaining descriptors are deduplicated by `(taxonomy, slug)`; the first
 *     label/description seen wins, matching the old behaviour where the first
 *     `ensureTerm` call cached the id.
 *   - One batched SELECT resolves existing rows at the requested locale.
 *   - One batched SELECT resolves any-locale rows for use as `translationOf`.
 *   - Missing rows are still created one at a time because each insert needs
 *     its own ULID/translation_group/sort_order bookkeeping, but the reads are
 *     where the round-trip bottleneck lives.
 */
async function ensureTermsBatch(
	db: Kysely<Database>,
	state: TaxonomyImportState,
	descriptors: TermDescriptor[],
	locale: string | undefined,
): Promise<void> {
	if (descriptors.length === 0) return;

	const repo = new TaxonomyRepository(db);

	const needed: TermDescriptor[] = [];
	const seenKeys = new Set<string>();
	for (const d of descriptors) {
		if (state.plan.termIdByNameAndSlug.get(d.taxonomyName)?.has(d.slug)) continue;
		const key = termKey(d.taxonomyName, d.slug);
		if (seenKeys.has(key)) continue;
		seenKeys.add(key);
		needed.push(d);
	}
	if (needed.length === 0) return;

	// Resolve existing rows at the requested locale in one round-trip.
	const existingAtLocale = await findExistingTerms(db, needed, locale);
	for (const row of existingAtLocale) {
		bump(state.plan.termsReused, row.name);
		rememberTerm(state, row.name, row.slug, row.id);
	}

	// Build the list of descriptors that still need creation.
	const stillNeeded: TermDescriptor[] = [];
	for (const d of needed) {
		if (!state.plan.termIdByNameAndSlug.get(d.taxonomyName)?.has(d.slug)) {
			stillNeeded.push(d);
		}
	}
	if (stillNeeded.length === 0) return;

	// Resolve any-locale rows once for translationOf linking.
	const anyLocaleRows = await findExistingTerms(db, stillNeeded, undefined);
	const translationOfByKey = new Map<string, string>();
	for (const row of anyLocaleRows) {
		const key = termKey(row.name, row.slug);
		if (!translationOfByKey.has(key)) translationOfByKey.set(key, row.id);
	}

	for (const d of stillNeeded) {
		const created = await repo.create({
			name: d.taxonomyName,
			slug: d.slug,
			label: d.label,
			data: d.description ? { description: d.description } : undefined,
			locale,
			translationOf: translationOfByKey.get(termKey(d.taxonomyName, d.slug)),
		});
		bump(state.plan.termsCreated, d.taxonomyName);
		rememberTerm(state, d.taxonomyName, d.slug, created.id);
	}
}

/** A term as the import's conflict messages name it */
const describeTerm = (d: TermDescriptor) => `"${d.taxonomyName}/${d.slug}" (${d.locale})`;

/**
 * Find or create terms whose locale the export records, each in that locale.
 * The members of one translation group are linked through `translationOf`.
 * Rows that already exist decide the group: missing members join it, anchored
 * on the existing member in the import's locale when there is one. The import
 * stops with a conflict when existing members sit in different groups, or
 * when a missing member would give its group a second row in one locale,
 * which the term API refuses too. Existing rows are looked up in one batched
 * SELECT per locale, and the rows of their groups in batched SELECTs too.
 */
async function ensureLocalizedTerms(
	db: Kysely<Database>,
	state: TaxonomyImportState,
	descriptors: TermDescriptor[],
	importLocale: string | undefined,
): Promise<void> {
	if (descriptors.length === 0) return;

	const repo = new TaxonomyRepository(db);

	const byLocale = new Map<string, TermDescriptor[]>();
	const groups = new Map<string, TermDescriptor[]>();
	for (const d of descriptors) {
		const locale = d.locale!;
		const sameLocale = byLocale.get(locale);
		if (sameLocale) sameLocale.push(d);
		else byLocale.set(locale, [d]);
		const groupKey = termKey(d.taxonomyName, d.translationKey ?? d.slug);
		const members = groups.get(groupKey);
		if (members) members.push(d);
		else groups.set(groupKey, [d]);
	}

	// Existing rows, each with the translation group it belongs to
	const existing = new Map<string, { id: string; group: string }>();
	for (const [locale, localeDescriptors] of byLocale) {
		for (const row of await findExistingTerms(db, localeDescriptors, locale)) {
			existing.set(localizedTermKey(row.name, row.slug, locale), {
				id: row.id,
				group: row.translation_group ?? row.id,
			});
		}
	}

	// Resolve every group's existing members, and the translation group they
	// share, before anything is created
	const resolved = Array.from(groups.values(), (members) => {
		const seen = new Set<string>();
		const ordered: Array<{ d: TermDescriptor; key: string; row?: { id: string; group: string } }> =
			[];
		const sorted = members.toSorted(
			(a, b) => Number(b.locale === importLocale) - Number(a.locale === importLocale),
		);
		for (const d of sorted) {
			const key = localizedTermKey(d.taxonomyName, d.slug, d.locale!);
			// A term the export lists twice
			if (seen.has(key)) continue;
			seen.add(key);
			ordered.push({ d, key, row: existing.get(key) });
		}
		const found = ordered.filter((member) => member.row !== undefined);
		const existingGroups = new Set(found.map((member) => member.row!.group));
		if (existingGroups.size > 1) {
			throw new WxrTaxonomyConflictError(
				`Cannot import: the translations ${found.map((member) => describeTerm(member.d)).join(" and ")} already exist in different translation groups. Link them in the admin (re-link via translationOf, or delete one) and retry.`,
			);
		}
		const [group] = existingGroups;
		return { ordered, found, group };
	});

	// A missing member may not give its group a second row in one locale
	const occupied = await findGroupLocales(
		db,
		resolved.flatMap(({ group }) => (group === undefined ? [] : [group])),
	);
	for (const { ordered, found, group } of resolved) {
		// Slug of each locale's row in the group the existing members share
		const groupLocales = group === undefined ? undefined : occupied.get(group);
		for (const { d, row } of ordered) {
			const taken = row ? undefined : groupLocales?.get(d.locale!);
			if (taken !== undefined) {
				throw new WxrTaxonomyConflictError(
					`Cannot import: term ${describeTerm(d)} would join the translation group of ${describeTerm(found[0].d)}, which already has "${d.taxonomyName}/${taken}" at locale "${d.locale}". Reconcile the rows in the admin (re-link via translationOf, or delete one) and retry.`,
				);
			}
		}
	}

	for (const { ordered, found } of resolved) {
		let anchorId = found[0]?.row?.id;
		for (const { d, key, row } of ordered) {
			let termId = row?.id ?? state.plan.termIdByNameSlugAndLocale.get(key);
			if (termId) {
				bump(state.plan.termsReused, d.taxonomyName);
			} else {
				const created = await repo.create({
					name: d.taxonomyName,
					slug: d.slug,
					label: d.label,
					data: d.description ? { description: d.description } : undefined,
					locale: d.locale,
					translationOf: anchorId,
				});
				bump(state.plan.termsCreated, d.taxonomyName);
				termId = created.id;
			}
			anchorId ??= termId;
			rememberTerm(state, d.taxonomyName, d.slug, termId);
			state.plan.termIdByNameSlugAndLocale.set(key, termId);
			state.plan.localizedTermIds.add(termId);
		}
	}
}

/**
 * Batched lookup of term rows for a list of `(taxonomy, slug)` pairs.
 * Chunks at `SQL_BATCH_SIZE / 2` because each pair consumes two bind
 * parameters (`name` and `slug`). When `locale` is omitted, returns rows
 * for all locales ordered by locale ascending so callers can pick the first
 * row per pair (mirroring `TaxonomyRepository.findBySlug` without a locale
 * argument).
 */
async function findExistingTerms(
	db: Kysely<Database>,
	descriptors: TermDescriptor[],
	locale: string | undefined,
): Promise<Array<{ id: string; name: string; slug: string; translation_group: string | null }>> {
	const { chunks, SQL_BATCH_SIZE } = await import("../utils/chunks.js");
	const rows: Array<{ id: string; name: string; slug: string; translation_group: string | null }> =
		[];
	const seenKeys = new Set<string>();

	// Each pair uses 2 bind params, so limit each batch to SQL_BATCH_SIZE / 2 pairs.
	for (const batch of chunks(descriptors, Math.floor(SQL_BATCH_SIZE / 2))) {
		const batchRows = await db
			.selectFrom("taxonomies")
			.select(["id", "name", "slug", "translation_group"])
			.where((eb) =>
				eb.or(batch.map((d) => eb.and([eb("name", "=", d.taxonomyName), eb("slug", "=", d.slug)]))),
			)
			.$if(locale !== undefined, (qb) => qb.where(localeMatches("locale", locale!)))
			.orderBy(locale !== undefined ? localeOrder("locale", locale) : "locale", "asc")
			.execute();

		for (const row of batchRows) {
			const key = termKey(row.name, row.slug);
			if (seenKeys.has(key)) continue;
			seenKeys.add(key);
			rows.push(row);
		}
	}

	return rows;
}

/**
 * Batched lookup of the rows in the given translation groups: for each group,
 * the slug of its row in each locale.
 */
async function findGroupLocales(
	db: Kysely<Database>,
	groups: string[],
): Promise<Map<string, Map<string, string>>> {
	const { chunks, SQL_BATCH_SIZE } = await import("../utils/chunks.js");
	const result = new Map<string, Map<string, string>>();
	for (const batch of chunks([...new Set(groups)], SQL_BATCH_SIZE)) {
		const rows = await db
			.selectFrom("taxonomies")
			.select(["translation_group", "locale", "slug"])
			.where("translation_group", "in", batch)
			.execute();
		for (const row of rows) {
			if (!row.translation_group) continue;
			const locales = result.get(row.translation_group) ?? new Map<string, string>();
			locales.set(row.locale, row.slug);
			result.set(row.translation_group, locales);
		}
	}
	return result;
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

	// Cache def lookups for the duration of the import. Keyed by name; value
	// is `null` when we've already determined the taxonomy is missing (so we
	// only report the "missing" warning once per taxonomy).
	const defCache = new Map<string, { id: string; collections: string[] } | null>();
	const lookupDef = async (name: string): Promise<{ id: string; collections: string[] } | null> => {
		if (defCache.has(name)) return defCache.get(name) ?? null;
		// A taxonomy's structure is the same in every locale, so a definition in
		// any locale counts, as it does for the runtime's `getTaxonomyDef`.
		const def = await findTaxonomyStructure(db, name);
		defCache.set(name, def);
		if (def) {
			state.plan.collectionsByTaxonomy.set(name, new Set(def.collections));
		}
		return def;
	};

	// Pass 1-3: collect every term declared at the top of the WXR, then
	// resolve them in a few batched queries instead of one round-trip per term.
	const categoryDef = await lookupDef("category");
	const tagDef = await lookupDef("tag");
	const topLevel: TermDescriptor[] = [];
	const polylang = polylangTermLocales(terms);
	const localeFields = (id: number | undefined) => {
		const recorded = id === undefined ? undefined : polylang.get(id);
		return recorded ? { locale: recorded.locale, translationKey: recorded.group } : {};
	};

	if (categoryDef) {
		for (const cat of categories) {
			if (!cat.nicename || !cat.name) continue;
			topLevel.push({
				taxonomyName: "category",
				slug: cat.nicename,
				label: cat.name,
				description: cat.description,
				...localeFields(cat.id),
			});
		}
	} else if (categories.length > 0) {
		state.plan.missingTaxonomies.push("category");
	}

	if (tagDef) {
		for (const tag of tags) {
			if (!tag.slug || !tag.name) continue;
			topLevel.push({
				taxonomyName: "tag",
				slug: tag.slug,
				label: tag.name,
				description: tag.description,
				...localeFields(tag.id),
			});
		}
	} else if (tags.length > 0) {
		state.plan.missingTaxonomies.push("tag");
	}

	for (const term of terms) {
		if (INTERNAL_TAXONOMIES.has(term.taxonomy)) continue;
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
		topLevel.push({
			taxonomyName,
			slug: term.slug,
			label: term.name,
			description: term.description,
			...localeFields(term.id),
		});
	}

	await ensureLocalizedTerms(
		db,
		state,
		topLevel.filter((d) => d.locale),
		locale,
	);
	await ensureTermsBatch(
		db,
		state,
		topLevel.filter((d) => !d.locale),
		locale,
	);

	// Pass 4: per-item assignments. Backfills terms missing from the top-
	// level blocks (rare, but observed in hand-edited or partial exports).
	// Collect every assignment first so we can batch-resolve them too.
	const fromPosts: TermDescriptor[] = [];
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
			fromPosts.push({
				taxonomyName: "category",
				slug,
				label: labelFor(post, "category", slug),
			});
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
			fromPosts.push({
				taxonomyName: "tag",
				slug,
				label: labelFor(post, "tag", slug),
			});
		}
		if (post.customTaxonomies) {
			for (const [rawName, slugs] of post.customTaxonomies) {
				if (INTERNAL_TAXONOMIES.has(rawName)) continue;
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
					fromPosts.push({
						taxonomyName,
						slug,
						label: labelFor(post, taxonomyName, slug),
					});
				}
			}
		}
	}

	await ensureTermsBatch(db, state, fromPosts, locale);

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
 * Polylang's own bookkeeping (`language`, already promoted to `post.locale`
 * by the parser, and its translation groups).
 */
export function resolvePostTermAssignments(
	collection: string,
	post: WxrPost,
	plan: TaxonomyImportPlan,
): Map<string, string[]> {
	const result = new Map<string, string[]>();
	const seen = new Set<string>();

	const tryResolve = (taxonomyName: string, slug: string): void => {
		const termId =
			(post.locale
				? plan.termIdByNameSlugAndLocale.get(localizedTermKey(taxonomyName, slug, post.locale))
				: undefined) ?? plan.termIdByNameAndSlug.get(taxonomyName)?.get(slug);
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
			if (INTERNAL_TAXONOMIES.has(rawName)) continue;
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
	const groups = new Set<string>();
	for (const [, termIds] of resolved) {
		for (const termId of termIds) {
			const group = await termTranslationGroup(repo, plan, termId);
			if (group) groups.add(group);
		}
	}
	return repo.attachGroupsToEntry(collection, entryId, [...groups]);
}

/**
 * Replace assignments per-taxonomy from a parsed WXR post. Used for
 * translations. Assignments belong to the content translation_group, so a
 * translated item's explicit taxonomy replaces that taxonomy for every
 * locale. Taxonomies with no resolvable permitted terms are left unchanged.
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
 * imports. Terms whose locale the export recorded are left as they are:
 * they exist in exactly the locales their translations cover.
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
			if (plan.localizedTermIds.has(canonicalTermId)) continue;
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
