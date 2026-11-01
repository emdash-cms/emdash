/**
 * SEO, byline credits and taxonomy terms staged in a draft revision.
 *
 * A collection that keeps drafts stages an entry's pending field values and slug
 * in its draft revision until publication. These three live in their own tables
 * rather than in the entry's columns, so for an entry that already has a live
 * version they are staged the same way, under reserved keys beside `_slug`, and
 * written to their tables when the draft is published. The leading underscore
 * keeps them out of the column writer and out of the entry's `data`.
 */

import type { Kysely } from "kysely";

import { BylineRepository, type ContentBylineInput } from "../../database/repositories/byline.js";
import { RevisionRepository } from "../../database/repositories/revision.js";
import { SeoRepository } from "../../database/repositories/seo.js";
import { TaxonomyRepository, type Taxonomy } from "../../database/repositories/taxonomy.js";
import {
	EmDashValidationError,
	type BylineSummary,
	type ContentBylineCredit,
	type ContentSeo,
	type ContentSeoInput,
} from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { invalidateTermCache } from "../../taxonomies/index.js";

/** The SEO input a draft stages, in the shape the content API accepts it. */
export const STAGED_SEO_KEY = "_seo";
/** The byline credits a draft stages, in the shape the content API accepts them. */
export const STAGED_BYLINES_KEY = "_bylines";
/**
 * The taxonomy terms a draft stages: taxonomy name to term translation groups,
 * the value an assignment stores. A save names terms by slug in the entry's
 * locale and the editor names them by row id, possibly in another locale; a
 * group holds either, and survives a term being renamed before publication.
 */
export const STAGED_TERMS_KEY = "_terms";

export interface StagedMetadata {
	seo?: ContentSeoInput;
	bylines?: ContentBylineInput[];
	/** Taxonomy name to term translation groups. */
	terms?: Record<string, string[]>;
}

const SEO_TEXT_KEYS = ["title", "description", "image", "canonical"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readSeo(value: unknown): ContentSeoInput | undefined {
	if (!isPlainRecord(value)) return undefined;
	const seo: ContentSeoInput = {};
	for (const key of SEO_TEXT_KEYS) {
		const field = value[key];
		if (typeof field === "string" || field === null) seo[key] = field;
	}
	if (typeof value.noIndex === "boolean") seo.noIndex = value.noIndex;
	return seo;
}

function readBylines(value: unknown): ContentBylineInput[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const credits: ContentBylineInput[] = [];
	for (const entry of value) {
		if (!isPlainRecord(entry) || typeof entry.bylineId !== "string") continue;
		credits.push({
			bylineId: entry.bylineId,
			roleLabel: typeof entry.roleLabel === "string" ? entry.roleLabel : null,
		});
	}
	return credits;
}

function readTerms(value: unknown): Record<string, string[]> | undefined {
	if (!isPlainRecord(value)) return undefined;
	const terms: Record<string, string[]> = {};
	for (const [taxonomy, slugs] of Object.entries(value)) {
		if (Array.isArray(slugs) && slugs.every((slug) => typeof slug === "string")) {
			terms[taxonomy] = slugs;
		}
	}
	return terms;
}

/** What a revision's data stages, by part. A part it does not stage is absent. */
export function readStagedMetadata(data: Record<string, unknown> | undefined): StagedMetadata {
	const staged: StagedMetadata = {};
	const seo = readSeo(data?.[STAGED_SEO_KEY]);
	if (seo) staged.seo = seo;
	const bylines = readBylines(data?.[STAGED_BYLINES_KEY]);
	if (bylines) staged.bylines = bylines;
	const terms = readTerms(data?.[STAGED_TERMS_KEY]);
	if (terms) staged.terms = terms;
	return staged;
}

export function hasStagedMetadata(staged: StagedMetadata): boolean {
	return staged.seo !== undefined || staged.bylines !== undefined || staged.terms !== undefined;
}

/**
 * The parts of a save that a collection with revisions stages instead of writing.
 *
 * An entry with a live version stages every part. An entry without one writes
 * them directly, except a part its draft already stages: written directly, that
 * part would be overwritten by the staged value when the draft is published.
 */
export function metadataToStage(
	input: StagedMetadata,
	isLive: boolean,
	draftData: Record<string, unknown> | undefined,
): StagedMetadata {
	const alreadyStaged = isLive ? undefined : readStagedMetadata(draftData);
	const staged: StagedMetadata = {};
	if (input.seo !== undefined && (isLive || alreadyStaged?.seo)) staged.seo = input.seo;
	if (input.bylines !== undefined && (isLive || alreadyStaged?.bylines)) {
		staged.bylines = input.bylines;
	}
	if (input.terms !== undefined && (isLive || alreadyStaged?.terms)) staged.terms = input.terms;
	return staged;
}

/**
 * The reserved keys a save writes into its draft revision, folded into what the
 * draft already stages. SEO merges field by field and terms taxonomy by taxonomy,
 * as their direct writes do; byline credits replace the staged list.
 */
export function stagedMetadataKeys(
	base: Record<string, unknown> | undefined,
	incoming: StagedMetadata,
): Record<string, unknown> {
	const current = readStagedMetadata(base);
	const keys: Record<string, unknown> = {};
	if (incoming.seo) {
		const seo: ContentSeoInput = { ...current.seo };
		for (const key of SEO_TEXT_KEYS) {
			if (incoming.seo[key] !== undefined) seo[key] = incoming.seo[key];
		}
		if (incoming.seo.noIndex !== undefined) seo.noIndex = incoming.seo.noIndex;
		keys[STAGED_SEO_KEY] = seo;
	}
	if (incoming.bylines) {
		keys[STAGED_BYLINES_KEY] = incoming.bylines.map((credit) => ({
			bylineId: credit.bylineId,
			roleLabel: credit.roleLabel ?? null,
		}));
	}
	if (incoming.terms) keys[STAGED_TERMS_KEY] = { ...current.terms, ...incoming.terms };
	return keys;
}

/**
 * Resolve a `{ taxonomyName: [slug, ...] }` map to terms, by taxonomy, in
 * `locale`. Passing `undefined` lets `findBySlug` fall back to its default
 * (lowest locale code), so callers on single-locale sites need not know it.
 *
 * Throws EmDashValidationError on an unknown slug or a wrong shape.
 */
async function resolveTaxonomyTerms(
	db: Kysely<Database>,
	locale: string | undefined,
	taxonomies: Record<string, string[]>,
): Promise<Map<string, Taxonomy[]>> {
	const taxRepo = new TaxonomyRepository(db);
	const resolved = new Map<string, Taxonomy[]>();

	for (const [taxonomyName, slugs] of Object.entries(taxonomies)) {
		if (!Array.isArray(slugs)) {
			throw new EmDashValidationError(`taxonomies.${taxonomyName} must be an array of term slugs`);
		}

		const terms: Taxonomy[] = [];
		for (const slug of slugs) {
			if (typeof slug !== "string" || slug.length === 0) {
				throw new EmDashValidationError(
					`taxonomies.${taxonomyName} contains a non-string or empty slug`,
				);
			}
			const term = await taxRepo.findBySlug(taxonomyName, slug, locale);
			if (!term) {
				throw new EmDashValidationError(
					`Unknown taxonomy term: ${taxonomyName}='${slug}'${
						locale ? ` (locale '${locale}')` : ""
					}`,
				);
			}
			terms.push(term);
		}
		resolved.set(taxonomyName, terms);
	}

	return resolved;
}

/**
 * Resolve a `{ taxonomyName: [slug, ...] }` map and replace the entry's
 * assignments for each named taxonomy, through the same `setTermsForEntry` path
 * the `.../terms/{taxonomy}` REST route uses.
 */
export async function assignTaxonomies(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	locale: string | undefined,
	taxonomies: Record<string, string[]>,
): Promise<void> {
	const resolved = await resolveTaxonomyTerms(db, locale, taxonomies);
	const taxRepo = new TaxonomyRepository(db);
	for (const [taxonomyName, terms] of resolved) {
		await taxRepo.setTermsForEntry(
			collection,
			entryId,
			taxonomyName,
			terms.map((term) => term.id),
		);
	}

	// Match the REST route's behaviour: taxonomy term assignments changed,
	// so invalidate the taxonomy object cache used during hydration.
	if (resolved.size > 0) invalidateTermCache();
}

/**
 * The term translation groups a `{ taxonomyName: [slug, ...] }` map names, in
 * `locale`, in the shape a draft stages. Throws EmDashValidationError as
 * `assignTaxonomies` would.
 */
export async function resolveTermGroups(
	db: Kysely<Database>,
	locale: string | undefined,
	taxonomies: Record<string, string[]>,
): Promise<Record<string, string[]>> {
	const groups: Record<string, string[]> = {};
	for (const [taxonomyName, terms] of await resolveTaxonomyTerms(db, locale, taxonomies)) {
		groups[taxonomyName] = [...new Set(terms.map((term) => term.translationGroup ?? term.id))];
	}
	return groups;
}

/**
 * Refuse metadata that its table write would refuse, without writing it: a
 * byline id that does not exist, or a term group with no term in its taxonomy.
 */
export async function validateStagedMetadata(
	db: Kysely<Database>,
	staged: StagedMetadata,
): Promise<void> {
	if (staged.bylines && staged.bylines.length > 0) {
		const ids = [...new Set(staged.bylines.map((credit) => credit.bylineId))];
		const rows = await db
			.selectFrom("_emdash_bylines")
			.select("id")
			.where("id", "in", ids)
			.execute();
		if (rows.length !== ids.length) {
			throw new EmDashValidationError("One or more byline IDs do not exist");
		}
	}
	for (const [taxonomyName, groups] of Object.entries(staged.terms ?? {})) {
		const wanted = new Set(groups);
		if (wanted.size === 0) continue;
		const rows = await db
			.selectFrom("taxonomies")
			.select("translation_group")
			.distinct()
			.where("name", "=", taxonomyName)
			.where("translation_group", "in", [...wanted])
			.execute();
		if (rows.length !== wanted.size) {
			throw new EmDashValidationError(
				`One or more ${taxonomyName} terms no longer exist; choose the terms again`,
			);
		}
	}
}

/**
 * Write staged metadata to its tables. SEO is skipped when the collection no
 * longer has SEO enabled.
 */
export async function applyStagedMetadata(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	staged: StagedMetadata,
	options: { hasSeo: boolean },
): Promise<void> {
	if (staged.seo && options.hasSeo) {
		await new SeoRepository(db).upsert(collection, entryId, staged.seo);
	}
	if (staged.bylines) {
		await new BylineRepository(db).setContentBylines(collection, entryId, staged.bylines);
	}
	if (staged.terms) {
		const taxRepo = new TaxonomyRepository(db);
		for (const [taxonomyName, groups] of Object.entries(staged.terms)) {
			await taxRepo.setTermsForEntry(collection, entryId, taxonomyName, groups);
		}
		invalidateTermCache();
	}
}

/** The term groups an entry's draft stages for one taxonomy, when it stages that taxonomy. */
export async function readDraftStagedTerms(
	db: Kysely<Database>,
	draftRevisionId: string | null,
	taxonomy: string,
): Promise<string[] | undefined> {
	if (!draftRevisionId) return undefined;
	const revision = await new RevisionRepository(db).findById(draftRevisionId);
	return readStagedMetadata(revision?.data).terms?.[taxonomy];
}

/** The entry fields a staged part overrides when an entry is read with its draft. */
export interface StagedMetadataView {
	seo?: ContentSeo;
	bylines?: ContentBylineCredit[];
	byline?: BylineSummary | null;
	primaryBylineId?: string | null;
}

/**
 * How an entry reads once its staged metadata is published: SEO with the staged
 * fields over the live ones, and credits resolved at the entry's locale, falling
 * back to the author's byline when the staged list is empty, as the read of
 * stored credits does.
 */
export async function stagedMetadataView(
	db: Kysely<Database>,
	item: Record<string, unknown>,
	staged: StagedMetadata,
): Promise<StagedMetadataView> {
	const view: StagedMetadataView = {};
	const liveSeo = item.seo;
	if (staged.seo && isPlainRecord(liveSeo)) {
		const seo: ContentSeo = {
			title: textOrNull(liveSeo.title),
			description: textOrNull(liveSeo.description),
			image: textOrNull(liveSeo.image),
			canonical: textOrNull(liveSeo.canonical),
			noIndex: liveSeo.noIndex === true,
		};
		for (const key of SEO_TEXT_KEYS) {
			const value = staged.seo[key];
			if (value !== undefined) seo[key] = value;
		}
		if (staged.seo.noIndex !== undefined) seo.noIndex = staged.seo.noIndex;
		view.seo = seo;
	}

	if (staged.bylines) {
		const locale = typeof item.locale === "string" ? item.locale : undefined;
		const bylineRepo = new BylineRepository(db);
		const { credits, primaryBylineId } = await bylineRepo.previewContentBylines(
			staged.bylines,
			locale ? { locale } : undefined,
		);
		view.primaryBylineId = primaryBylineId;
		if (credits.length > 0) {
			view.bylines = credits.map((credit) => ({ ...credit, source: "explicit" as const }));
			view.byline = credits[0]?.byline ?? null;
		} else {
			const fallback =
				staged.bylines.length === 0 && typeof item.authorId === "string"
					? await bylineRepo.findByUserId(item.authorId, locale ? { locale } : undefined)
					: null;
			view.bylines = fallback
				? [{ byline: fallback, sortOrder: 0, roleLabel: null, source: "inferred" }]
				: [];
			view.byline = fallback;
		}
	}

	return view;
}
