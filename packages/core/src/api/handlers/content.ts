/**
 * Content CRUD handlers
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { ContentFieldFilters } from "../../content-list-query.js";
import { isSqlite } from "../../database/dialect-helpers.js";
import { BylineRepository } from "../../database/repositories/byline.js";
import type { ContentBylineInput } from "../../database/repositories/byline.js";
import { CommentRepository } from "../../database/repositories/comment.js";
import {
	ContentRepository,
	isSystemOrderField,
	type ContentRevisionPrecondition,
} from "../../database/repositories/content.js";
import { EntryLockRepository } from "../../database/repositories/entry-locks.js";
import { OptionsRepository } from "../../database/repositories/options.js";
import { RedirectRepository } from "../../database/repositories/redirect.js";
import { RelationRepository } from "../../database/repositories/relation.js";
import { RevisionRepository } from "../../database/repositories/revision.js";
import { SeoRepository } from "../../database/repositories/seo.js";
import { TaxonomyRepository } from "../../database/repositories/taxonomy.js";
import {
	ContentCollectionNotFoundError,
	ContentMutationConflictError,
	EmDashValidationError,
	ScheduledNotDueError,
	InvalidCursorError,
	type BylineSummary,
	type ContentBylineCredit,
	type ContentBylineFilter,
	type ContentDateField,
	type ContentItem,
	type ContentSeo,
	type ContentSeoInput,
	type FindManyOptions,
} from "../../database/repositories/types.js";
import { UserRepository } from "../../database/repositories/user.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { getI18nConfig, isI18nEnabled, resolveConfiguredLocale } from "../../i18n/config.js";
import {
	scheduledPolicyRejectionKey,
	type ScheduledPolicyRejection,
} from "../../plugins/content-policy.js";
import { invalidateRedirectCache } from "../../redirects/cache.js";
import { isStoragelessFieldRow } from "../../schema/types.js";
import { FTSManager } from "../../search/fts-manager.js";
import { invalidateTermCache } from "../../taxonomies/index.js";
import { isMissingColumnError, isMissingTableError } from "../../utils/db-errors.js";
import { decodeRev, encodeRev, validateRev } from "../rev.js";
import type { ApiResult, ContentListResponse, ContentResponse } from "../types.js";
import {
	getReferenceTitleField,
	type ReferenceSelectionWrite,
	resolveEntries,
	resolveEntryGroups,
	resolveReferenceSelection,
	resolveReferenceSelectionTargets,
	type ResolvedReferenceTargets,
	writeReferenceSelection,
} from "./relations.js";
import {
	applyStagedReferences,
	liveReferenceSelection,
	pageStagedGroups,
	readStagedReferences,
	recordPublishedReferences,
	STAGED_REFERENCES_KEY,
	type StagedReferences,
	validateStagedReferences,
} from "./staged-references.js";
import { validateMediaFields } from "./validate-media-fields.js";
import {
	referenceFieldConstraints,
	validateRequiredReferencesPresent,
} from "./validate-references.js";

/**
 * Narrow a caught error to one carrying a structured `apiError` discriminant.
 * Used by transaction callbacks that want to surface a specific error code
 * through the standard Error throwing path.
 */
function hasApiError(error: unknown): error is Error & { apiError: { code: string } } {
	if (!(error instanceof Error) || !("apiError" in error)) return false;
	const { apiError } = error;
	return (
		typeof apiError === "object" &&
		apiError !== null &&
		"code" in apiError &&
		typeof apiError.code === "string"
	);
}

/**
 * Abort the surrounding transaction when a relation's limit refused an edge.
 *
 * `farSide` names the end that filled up, which is the opposite of the end the
 * refused group sits on: a child that cannot take another parent refuses with
 * `"parent"`.
 */
function throwIfReferenceLimitRefused(rejected: string[], farSide: "parent" | "child"): void {
	if (rejected.length === 0) return;
	throw Object.assign(
		new Error(
			`Entry '${rejected[0]}' already has the maximum number of ${farSide} entries on this relation.`,
		),
		{ apiError: { code: "VALIDATION_ERROR" } },
	);
}

/** The slug a draft revision stages, when it stages one. */
function readStagedSlug(data: Record<string, unknown> | undefined): string | null {
	return typeof data?._slug === "string" ? data._slug : null;
}

/**
 * Make every refusal `publish()` decides before it writes, ahead of it.
 *
 * `publish()` decides all of them again and stays authoritative; this does not
 * replace it. It exists for the one caller that has irreversible work to do
 * first — promoting a draft's staged reference selection, which nothing takes
 * back where `withTransaction` degrades to plain statements. A refusal that
 * landed after that promotion would leave a draft's links live on an entry that
 * never published.
 *
 * The optimistic fence `publish()` ends on is not checked here, because it is
 * the write itself: a publish lost to a concurrent edit still promotes.
 */
async function assertPublishWillNotBeRefused(
	db: Kysely<Database>,
	collection: string,
	id: string,
	existing: ContentItem,
	options: {
		stagedSlug: string | null;
		requireSlug: boolean;
		requireDue?: boolean;
		expectedScheduledAt?: string;
		expectedRevision?: ContentRevisionPrecondition;
	},
): Promise<void> {
	const { expectedRevision } = options;
	if (
		expectedRevision &&
		(existing.version !== expectedRevision.version ||
			existing.updatedAt !== expectedRevision.updatedAt)
	) {
		throw new ContentMutationConflictError();
	}

	if (
		options.requireDue &&
		options.expectedScheduledAt !== undefined &&
		existing.scheduledAt !== options.expectedScheduledAt
	) {
		throw new ScheduledNotDueError();
	}

	const intendedSlug = options.stagedSlug ?? existing.slug;
	if (options.requireSlug && !intendedSlug?.trim()) {
		throw new EmDashValidationError("Cannot publish routable content without a slug");
	}

	// Only a publish that moves the slug can collide, so this costs a read on
	// that path alone.
	if (
		options.stagedSlug !== null &&
		options.stagedSlug !== existing.slug &&
		existing.locale !== null
	) {
		const conflict = await new ContentRepository(db).findBySlugIncludingTrashed(
			collection,
			options.stagedSlug,
			existing.locale,
		);
		if (conflict && conflict.id !== id) {
			throw new EmDashValidationError(
				`Cannot publish: slug '${options.stagedSlug}' is already used by another entry` +
					` in this collection (id: ${conflict.id}). Choose a different slug.`,
				{ code: "SLUG_CONFLICT" },
			);
		}
	}
}

function isTranslationLocaleConflict(error: unknown, collection: string): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	const storedIndexName = `uidx_ec_${collection}_active_tg_locale`.slice(0, 63).toLowerCase();
	return (
		message.includes(storedIndexName) ||
		(message.includes("unique constraint failed") &&
			message.includes("translation_group") &&
			message.includes("locale"))
	);
}

function decodeRevisionPrecondition(
	rev: string | undefined,
): ContentRevisionPrecondition | undefined {
	if (rev === undefined) return undefined;
	const decoded = decodeRev(rev);
	if (!decoded) throw new ContentMutationConflictError("Revision precondition did not match");
	return decoded;
}

/**
 * Extract a slug source (title or name) from content data.
 * Returns null if no suitable string field is found.
 */
function getSlugSource(data: Record<string, unknown>): string | null {
	if (typeof data.title === "string" && data.title.length > 0) return data.title;
	if (typeof data.name === "string" && data.name.length > 0) return data.name;
	return null;
}

/** Default SEO values for content without an explicit SEO row */
const SEO_DEFAULTS: ContentSeo = {
	title: null,
	description: null,
	image: null,
	canonical: null,
	noIndex: false,
};

/**
 * Check if a collection has SEO enabled.
 */
async function collectionHasSeo(db: Kysely<Database>, collection: string): Promise<boolean> {
	const row = await db
		.selectFrom("_emdash_collections")
		.select("has_seo")
		.where("slug", "=", collection)
		.executeTakeFirst();
	return row?.has_seo === 1;
}

async function getCollectionPublishConfig(
	db: Kysely<Database>,
	collection: string,
): Promise<{ supportsRevisions: boolean; routable: boolean }> {
	const row = await db
		.selectFrom("_emdash_collections")
		.select(["supports", "routable"])
		.where("slug", "=", collection)
		.executeTakeFirst();
	const supports: unknown = row?.supports ? JSON.parse(row.supports) : [];
	return {
		supportsRevisions: Array.isArray(supports) && supports.includes("revisions"),
		routable: row?.routable !== 0,
	};
}

function requireRoutablePublishSlug(routable: boolean, slug: string | null | undefined): void {
	if (routable && !slug?.trim()) {
		throw new EmDashValidationError("Cannot publish routable content without a slug");
	}
}

/**
 * Hydrate SEO data on a single content item if the collection has SEO enabled.
 */
async function hydrateSeo(
	db: Kysely<Database>,
	collection: string,
	item: ContentItem,
	hasSeo: boolean,
): Promise<void> {
	if (!hasSeo) return;
	const seoRepo = new SeoRepository(db);
	item.seo = await seoRepo.get(collection, item.id);
}

/**
 * Hydrate SEO data on multiple content items using a single batch query.
 */
async function hydrateSeoMany(
	db: Kysely<Database>,
	collection: string,
	items: ContentItem[],
	hasSeo: boolean,
): Promise<void> {
	if (!hasSeo || items.length === 0) return;
	const seoRepo = new SeoRepository(db);
	const seoMap = await seoRepo.getMany(
		collection,
		items.map((i) => i.id),
	);
	for (const item of items) {
		item.seo = seoMap.get(item.id) ?? { ...SEO_DEFAULTS };
	}
}

async function hydrateBylines(
	db: Kysely<Database>,
	collection: string,
	item: ContentItem,
): Promise<void> {
	const bylineRepo = new BylineRepository(db);
	// Strict per-locale (migration 040): a credit at locale X renders iff a
	// byline row exists at locale X in the credited translation_group. The
	// junction itself spans translations; rendering does not fall back.
	const localeOpt = item.locale ? { locale: item.locale } : undefined;
	const bylines = await bylineRepo.getContentBylines(collection, item.id, localeOpt);

	if (bylines.length > 0) {
		item.bylines = bylines.map((c) => ({ ...c, source: "explicit" as const }));
		item.byline = bylines[0]?.byline ?? null;
		return;
	}

	// `primaryBylineId` is set iff junction rows exist; non-null
	// suppresses author fallback even when the credit doesn't resolve
	// at this locale.
	if (item.primaryBylineId) {
		item.bylines = [];
		item.byline = null;
		return;
	}

	if (item.authorId) {
		// Same strict-locale rule as explicit credits: a user-linked byline
		// renders on the entry only when a sibling exists at the entry's
		// locale. Without this we'd silently surface the default-locale
		// row, which contradicts the per-locale model.
		const fallback = await bylineRepo.findByUserId(item.authorId, localeOpt);
		if (fallback) {
			item.bylines = [{ byline: fallback, sortOrder: 0, roleLabel: null, source: "inferred" }];
			item.byline = fallback;
			return;
		}
	}

	item.bylines = [];
	item.byline = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Hydrate the first page of each reference field's selection onto a single
 * content item, keyed by field slug — the same key the create and update bodies
 * take a selection under.
 *
 * Callers must have already decided `includeDrafts` — draft visibility is
 * enforced by the caller, not this helper — because a resolved entry can carry
 * a draft or scheduled entry's id and slug. The admin's REST GET route is the
 * only caller, and it asks for every entry it serves, so a collection with no
 * reference field still pays the two lookups below.
 *
 * For a caller that opted into drafts, a field whose selection is staged in the
 * entry's draft revision is answered from that revision; every other field, and
 * every field for a caller that did not opt in, is answered from the links,
 * which hold the published selection. That is what keeps a picker change on a
 * published entry invisible until it is published.
 *
 * Either selection arrives one page at a time, with the cursor to walk the rest
 * through the edge routes — a draft's pending selection can be as long as a
 * published one, and a caller that reads an entry should not have to take a
 * field of a thousand entries to find out.
 */
async function hydrateReferences(
	db: Kysely<Database>,
	collection: string,
	item: ContentItem,
	includeDrafts: boolean,
): Promise<void> {
	if (!item.translationGroup) return;

	const collectionRow = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collection)
		.executeTakeFirst();
	if (!collectionRow) return;

	const fields = await db
		.selectFrom("_emdash_fields")
		.select(["slug", "validation"])
		.where("collection_id", "=", collectionRow.id)
		.where("type", "=", "reference")
		.execute();

	const references: NonNullable<ContentItem["references"]> = {};
	if (fields.length === 0) {
		item.references = references;
		return;
	}

	const repo = new RelationRepository(db);
	const content = new ContentRepository(db);

	const staged =
		includeDrafts && item.draftRevisionId
			? readStagedReferences(
					(await new RevisionRepository(db).findById(item.draftRevisionId))?.data,
				)
			: undefined;

	for (const field of fields) {
		let validation: Record<string, unknown> = {};
		if (field.validation) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(field.validation);
			} catch {
				continue;
			}
			if (isRecord(parsed)) validation = parsed;
		}
		const relation = typeof validation.relation === "string" ? validation.relation : undefined;
		const targetCollection =
			typeof validation.targetCollection === "string" ? validation.targetCollection : undefined;
		// A field with no relation keeps its own column; its value is already in
		// `data` and there are no links to resolve.
		if (!relation || !targetCollection) continue;

		const stagedGroups = staged?.[field.slug];
		if (stagedGroups) {
			// Paged like the links below it: the REST contract promises one page and
			// a cursor whichever selection answers, and the editor walks the rest
			// through the same edge route either way.
			const page = pageStagedGroups(stagedGroups);
			references[field.slug] = {
				children: await resolveEntryGroups(
					content,
					targetCollection,
					page.groups,
					item.locale,
					includeDrafts,
					await getReferenceTitleField(db, targetCollection),
				),
				...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
			};
			continue;
		}

		// A field on the child end of its relation selects parents, which carry no
		// order of their own — `sort_order` positions children within one parent.
		const onChildSide = validation.relationSide === "child";
		const edges = onChildSide
			? await repo.getParentsPage(relation, item.translationGroup)
			: await repo.getChildrenPage(relation, item.translationGroup);
		const children = await resolveEntries(
			content,
			targetCollection,
			edges.items,
			(e) => (onChildSide ? e.parentGroup : e.childGroup),
			item.locale,
			includeDrafts,
			await getReferenceTitleField(db, targetCollection),
		);
		references[field.slug] = {
			children,
			...(edges.nextCursor ? { nextCursor: edges.nextCursor } : {}),
		};
	}

	item.references = references;
}

/**
 * Batch-hydrate bylines for multiple items using two bulk queries instead of N+1.
 *
 * Items may live at different locales (e.g. a list endpoint returning the
 * translations of an entry). Group by `item.locale` and call the strict
 * per-locale repo method once per group so each item resolves against its
 * own locale's byline rows.
 */
async function hydrateBylinesMany(
	db: Kysely<Database>,
	collection: string,
	items: ContentItem[],
): Promise<void> {
	if (items.length === 0) return;

	const bylineRepo = new BylineRepository(db);

	// 1. Bucket items by locale so we can call the strict-locale repo
	//    once per bucket. Items with a null/undefined locale (pre-i18n
	//    rows on a single-locale install) share an "unscoped" bucket.
	const localeBuckets = new Map<string | null, ContentItem[]>();
	for (const item of items) {
		const key = item.locale ?? null;
		const bucket = localeBuckets.get(key);
		if (bucket) bucket.push(item);
		else localeBuckets.set(key, [item]);
	}

	// 2. Per-locale: fetch explicit credits. Items whose credits don't
	//    resolve at this locale go through a locale-agnostic "has any
	//    junction" check before being considered for author inference —
	//    explicit editorial intent at any locale beats inferred fallback.
	const bylinesByItem = new Map<string, ContentBylineCredit[]>();
	const itemsNeedingAuthorCheck: ContentItem[] = [];
	for (const [locale, bucket] of localeBuckets) {
		const localeOpt = locale ? { locale } : undefined;
		const ids = bucket.map((i) => i.id);
		const credits = await bylineRepo.getContentBylinesMany(collection, ids, localeOpt);
		for (const [id, list] of credits) bylinesByItem.set(id, list);

		for (const item of bucket) {
			if (credits.has(item.id) && credits.get(item.id)!.length > 0) continue;
			if (item.authorId) itemsNeedingAuthorCheck.push(item);
		}
	}

	// 3. Author fallback applies only when no explicit credit exists
	//    (primaryBylineId null).
	const fallbackByItem = new Map<string, BylineSummary>();
	if (itemsNeedingAuthorCheck.length > 0) {
		const authorBuckets = new Map<string | null, ContentItem[]>();
		for (const item of itemsNeedingAuthorCheck) {
			if (item.primaryBylineId) continue;
			const key = item.locale ?? null;
			const bucket = authorBuckets.get(key);
			if (bucket) bucket.push(item);
			else authorBuckets.set(key, [item]);
		}

		for (const [locale, bucket] of authorBuckets) {
			const localeOpt = locale ? { locale } : undefined;
			const authorIds = bucket.map((i) => i.authorId).filter((id): id is string => id !== null);
			const uniqueAuthorIds = [...new Set(authorIds)];
			if (uniqueAuthorIds.length === 0) continue;
			const authorMap = await bylineRepo.findByUserIds(uniqueAuthorIds, localeOpt);
			for (const item of bucket) {
				if (!item.authorId) continue;
				const f = authorMap.get(item.authorId);
				if (f) fallbackByItem.set(item.id, f);
			}
		}
	}

	// 4. Assign to each item.
	for (const item of items) {
		const explicit = bylinesByItem.get(item.id);
		if (explicit && explicit.length > 0) {
			item.bylines = explicit.map((c) => ({ ...c, source: "explicit" as const }));
			item.byline = explicit[0]?.byline ?? null;
			continue;
		}

		const fallback = fallbackByItem.get(item.id);
		if (fallback) {
			item.bylines = [{ byline: fallback, sortOrder: 0, roleLabel: null, source: "inferred" }];
			item.byline = fallback;
			continue;
		}

		item.bylines = [];
		item.byline = null;
	}
}

/**
 * Resolve an identifier (ID or slug) to a real content ID.
 * Returns the ID if found, null if not found.
 * When locale is provided, slug lookups are scoped to that locale.
 */
async function resolveId(
	repo: ContentRepository,
	collection: string,
	identifier: string,
	locale?: string,
): Promise<string | null> {
	const item = await repo.findByIdOrSlug(
		collection,
		identifier,
		locale ? resolveConfiguredLocale(locale) : undefined,
	);
	return item?.id ?? null;
}

/**
 * Resolve an identifier (ID or slug) to a real content ID,
 * including trashed (soft-deleted) items.
 */
async function resolveIdIncludingTrashed(
	repo: ContentRepository,
	collection: string,
	identifier: string,
	locale?: string,
): Promise<string | null> {
	const item = await repo.findByIdOrSlugIncludingTrashed(
		collection,
		identifier,
		locale ? resolveConfiguredLocale(locale) : undefined,
	);
	return item?.id ?? null;
}

/**
 * Trashed content item with deletion timestamp
 */
export interface TrashedContentItem {
	id: string;
	type: string;
	slug: string | null;
	status: string;
	locale: string | null;
	translationGroup: string | null;
	data: Record<string, unknown>;
	authorId: string | null;
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
	deletedAt: string;
}

/**
 * Resolve the columns a content-list search should match against. Always
 * includes `slug` (a standard column), adds the configured `titleField` plus
 * the `title`/`name` display fields when the collection actually defines them,
 * mirroring the admin's item-title resolution (titleField -> title -> name ->
 * slug), and includes every field explicitly marked searchable. Returning only
 * schema-backed columns avoids "no such column" errors.
 */
async function resolveSearchColumns(db: Kysely<Database>, collection: string): Promise<string[]> {
	const row = await db
		.selectFrom("_emdash_collections")
		.select(["id", "title_field"])
		.where("slug", "=", collection)
		.executeTakeFirst();
	if (!row) return ["slug"];

	const fields = await db
		.selectFrom("_emdash_fields")
		.select(["slug", "searchable"])
		.where("collection_id", "=", row.id)
		.orderBy("sort_order", "asc")
		.execute();
	const columns = new Set(["slug"]);
	const fieldSlugs = new Set(fields.map((f) => f.slug));

	// A configured titleField takes precedence, then the conventional
	// title/name fields. A null title_field falls through to those defaults.
	if (row.title_field && fieldSlugs.has(row.title_field)) columns.add(row.title_field);
	for (const candidate of ["title", "name"]) {
		if (fieldSlugs.has(candidate)) columns.add(candidate);
	}
	for (const field of fields) {
		if (field.searchable === 1) columns.add(field.slug);
	}
	return [...columns];
}

/**
 * The keys of `data` that name a storage-less field — a reference field bound
 * to a relation, whose selection lives in the edge table and reaches the API
 * under the separate `references` key.
 *
 * A reference field with no relation still owns its column, so its value in
 * `data` is exactly where it belongs and is not returned here.
 */
async function storagelessDataKeys(
	db: Kysely<Database>,
	collection: string,
	data: Record<string, unknown>,
): Promise<string[]> {
	const collectionRow = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collection)
		.executeTakeFirst();
	if (!collectionRow) return [];
	const fields = await db
		.selectFrom("_emdash_fields")
		.select(["slug", "type", "validation"])
		.where("collection_id", "=", collectionRow.id)
		.execute();
	const storageless = new Set(fields.filter(isStoragelessFieldRow).map((f) => f.slug));
	if (storageless.size === 0) return [];
	return Object.keys(data).filter((key) => storageless.has(key));
}

/**
 * Refuse a `data` payload that tries to set a storage-less field.
 *
 * Such a key would otherwise reach the column writer and throw "no such
 * column". Dropping it instead is worse than refusing it: a client that can
 * only write `data` would be told its write succeeded while nothing was linked.
 * On a collection that keeps drafts the key never reaches the column writer at
 * all — it is merged into the draft revision's JSON — so the runtime applies
 * this before staging rather than leaving it to the write below.
 */
export function storagelessDataKeyError(keys: string[]): {
	success: false;
	error: { code: string; message: string };
} {
	return {
		success: false,
		error: {
			code: "VALIDATION_ERROR",
			message: `Reference fields bound to a relation are set through 'references', not 'data': ${keys.join(", ")}`,
		},
	};
}

/**
 * The storage-less keys in `data` that an update is actually trying to change.
 *
 * A field bound to a relation after its column existed keeps that column, and
 * every read hands the value frozen in it back under the field's own slug. A
 * read-then-write client — the admin editor among them — therefore echoes a key
 * it never touched, and refusing that would make such an entry unsaveable. An
 * echo asks for nothing; a different value is an attempt to set a selection
 * through the one channel that cannot carry it.
 *
 * A key the entry does not store counts as changed, which is every key of a
 * field that never had a column: there is nothing for such a payload to be
 * echoing, and letting it through would reach the column writer.
 */
export function changedStoragelessDataKeys(
	storageless: ReadonlySet<string>,
	data: Record<string, unknown>,
	stored: Record<string, unknown>,
): string[] {
	return Object.keys(data).filter(
		(key) =>
			storageless.has(key) &&
			(!Object.hasOwn(stored, key) || JSON.stringify(data[key]) !== JSON.stringify(stored[key])),
	);
}

/**
 * Decide whether the content-list `q` filter can be served from the
 * collection's FTS5 index instead of a full-scan substring LIKE (#1517).
 *
 * Requires SQLite (FTS5 is SQLite-only), search enabled on the collection,
 * every non-slug display column present in the searchable-field set (or the
 * index would miss matches the LIKE finds), and the index table actually
 * existing.
 */
async function canUseFtsForListFilter(
	db: Kysely<Database>,
	collection: string,
	searchColumns: string[],
): Promise<boolean> {
	if (!isSqlite(db)) return false;
	const ftsManager = new FTSManager(db);
	const config = await ftsManager.getSearchConfig(collection);
	if (!config?.enabled) return false;
	const searchable = new Set(await ftsManager.getSearchableFields(collection));
	const covered = searchColumns.every((col) => col === "slug" || searchable.has(col));
	if (!covered) return false;
	return ftsManager.ftsTableExists(collection);
}

/**
 * Create a 301 auto-redirect from an entry's old URL to its new one after a
 * slug change, using the collection's URL pattern. Shared by
 * handleContentUpdate (direct slug edits) and handleContentPublish (slug edits
 * staged as `_slug` in a draft revision, which only land on publish).
 */
async function createSlugChangeRedirect(
	db: Kysely<Database>,
	collection: string,
	oldSlug: string,
	newSlug: string,
	contentId: string,
	oldPublishedAt: string | null,
	newPublishedAt: string | null,
): Promise<void> {
	// A URL pattern has no locale token, so every locale variant of an entry
	// generates the same URL, and slugs are unique per (slug, locale) — a
	// translation may still hold the old slug. Redirecting away from a URL
	// another row still answers on would take that page down: the redirect
	// middleware runs `order: "pre"`, so routing never gets a chance.
	// Any surviving row counts, published or not: a draft that publishes later
	// would otherwise be shadowed by the redirect.
	if (await slugStillTaken(db, collection, oldSlug, contentId)) return;

	const collectionRow = await db
		.selectFrom("_emdash_collections")
		.select("url_pattern")
		.where("slug", "=", collection)
		.executeTakeFirst();

	const redirectRepo = new RedirectRepository(db);
	await redirectRepo.createAutoRedirect(
		collection,
		oldSlug,
		newSlug,
		contentId,
		collectionRow?.url_pattern ?? null,
		oldPublishedAt,
		newPublishedAt,
	);
	invalidateRedirectCache();
}

/** Whether a row other than `contentId` still holds `slug` in this collection. */
async function slugStillTaken(
	db: Kysely<Database>,
	collection: string,
	slug: string,
	contentId: string,
): Promise<boolean> {
	validateIdentifier(collection, "collection slug");
	const result = await sql<{ id: string }>`
		SELECT id FROM ${sql.ref(`ec_${collection}`)}
		WHERE slug = ${slug}
		AND id != ${contentId}
		AND deleted_at IS NULL
		LIMIT 1
	`.execute(db);
	return result.rows.length > 0;
}

/** Matches a date-only `YYYY-MM-DD` bound (no time component). */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize a date-range bound to an ISO datetime for lexicographic comparison
 * against stored ISO 8601 timestamps. A bare `YYYY-MM-DD` is widened to the
 * appropriate UTC day boundary so the range stays inclusive: a `start` bound
 * becomes the start of the day and an `end` bound the end of the day.
 * Otherwise a date-only upper bound would exclude every same-day row (since
 * `2024-06-01T12:00:00Z` sorts after `2024-06-01`). Full datetimes pass
 * through unchanged.
 */
function normalizeDateBound(value: string | undefined, edge: "start" | "end"): string | undefined {
	if (!value) return undefined;
	if (!DATE_ONLY_RE.test(value)) return new Date(value).toISOString();
	return edge === "start" ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
}

/**
 * Build the repository's byline filter from the wire params.
 *
 * `locale` is the locale the list is scoped to, which is the locale an
 * inferred credit has to resolve at — the admin list is always scoped to the
 * locale picked in its switcher.
 */
function resolveBylineFilter(
	params: { bylines?: string[]; bylinesNone?: boolean; includeInferredBylines?: boolean },
	locale: string | undefined,
): ContentBylineFilter | undefined {
	const includeInferred = params.includeInferredBylines === true;

	if (params.bylinesNone) return { mode: "none", includeInferred, locale };

	const bylineIds = params.bylines ?? [];
	if (bylineIds.length === 0) return undefined;

	return { mode: "any", bylineIds, includeInferred, locale };
}

/**
 * Create content list handler
 */
export async function handleContentList(
	db: Kysely<Database>,
	collection: string,
	params: {
		cursor?: string;
		limit?: number;
		status?: string;
		orderBy?: string;
		order?: "asc" | "desc";
		locale?: string;
		q?: string;
		authorId?: string;
		dateField?: ContentDateField;
		dateFrom?: string;
		dateTo?: string;
		bylines?: string[];
		bylinesNone?: boolean;
		includeInferredBylines?: boolean;
		fieldFilters?: ContentFieldFilters;
	},
): Promise<ApiResult<ContentListResponse>> {
	try {
		const repo = new ContentRepository(db);
		const where: FindManyOptions["where"] = {};
		if (params.status) where.status = params.status;
		const locale = params.locale ? resolveConfiguredLocale(params.locale) : undefined;
		if (locale) where.locale = locale;
		if (params.authorId) where.authorId = params.authorId;
		if (params.fieldFilters && Object.keys(params.fieldFilters).length > 0) {
			where.fieldFilters = params.fieldFilters;
		}

		const bylineFilter = resolveBylineFilter(params, locale);
		if (bylineFilter) where.bylineFilter = bylineFilter;

		// A date range requires a target column; ignore stray from/to without
		// a field so a half-specified filter doesn't silently drop all rows.
		if (params.dateField && (params.dateFrom || params.dateTo)) {
			where.dateFilter = {
				field: params.dateField,
				from: normalizeDateBound(params.dateFrom, "start"),
				to: normalizeDateBound(params.dateTo, "end"),
			};
		}

		const q = params.q?.trim();
		if (q) {
			where.q = q;
			where.searchColumns = await resolveSearchColumns(db, collection);
			where.useFts = await canUseFtsForListFilter(db, collection, where.searchColumns);
		}

		// Sorting by a non-system field (a collection's titleField/dateField)
		// needs the collection's *actual* sort fields resolved server-side,
		// so the orderBy set stays closed. Only query when it's not a system field.
		let sortableExtras: string[] | undefined;
		if (params.orderBy && !isSystemOrderField(params.orderBy)) {
			const coll = await db
				.selectFrom("_emdash_collections")
				.select(["title_field", "date_field"])
				.where("slug", "=", collection)
				.executeTakeFirst();
			sortableExtras = [coll?.title_field, coll?.date_field].filter(
				(slug): slug is string => !!slug,
			);
		}

		const result = await repo.findMany(collection, {
			cursor: params.cursor,
			limit: params.limit || 50,
			where: Object.keys(where).length > 0 ? where : undefined,
			orderBy: params.orderBy
				? { field: params.orderBy, direction: params.order || "desc" }
				: undefined,
			sortableExtras,
		});

		// Hydrate SEO data if the collection has SEO enabled
		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeoMany(db, collection, result.items, hasSeo);
		await hydrateBylinesMany(db, collection, result.items);

		return {
			success: true,
			data: {
				items: result.items,
				nextCursor: result.nextCursor,
				total: result.total,
			},
		};
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: { code: "INVALID_CURSOR", message: error.message },
			};
		}
		if (error instanceof ContentCollectionNotFoundError || isMissingTableError(error)) {
			return {
				success: false,
				error: {
					code: "COLLECTION_NOT_FOUND",
					message: `Collection '${collection}' not found`,
				},
			};
		}
		if (isMissingColumnError(error, "deleted_at")) {
			return {
				success: false,
				error: {
					code: "COLLECTION_SCHEMA_MISMATCH",
					message: `Collection '${collection}' backing table is missing the 'deleted_at' column`,
				},
			};
		}
		if (error instanceof EmDashValidationError) {
			// e.g. invalid orderBy field
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: error.message },
			};
		}
		console.error("Content list error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_LIST_ERROR",
				message: "Failed to list content",
			},
		};
	}
}

/** A content author option for the admin author filter. */
export interface ContentAuthor {
	id: string;
	name: string | null;
	email: string;
	avatarUrl: string | null;
}

/**
 * List the distinct authors of a collection's live content.
 *
 * Backs the admin content-list author filter. Unlike `/admin/users` (ADMIN
 * only), this is gated on `content:read`, so any editor can filter by author.
 * Returns only users who have authored at least one non-trashed entry, sorted
 * by display name then email for a stable dropdown order.
 */
export async function handleContentAuthors(
	db: Kysely<Database>,
	collection: string,
): Promise<ApiResult<{ items: ContentAuthor[] }>> {
	try {
		const repo = new ContentRepository(db);
		const authorIds = await repo.findDistinctAuthorIds(collection);
		if (authorIds.length === 0) {
			return { success: true, data: { items: [] } };
		}

		const userRepo = new UserRepository(db);
		const users = await userRepo.findByIds(authorIds);

		const items: ContentAuthor[] = users
			.map((u) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl }))
			.toSorted((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));

		return { success: true, data: { items } };
	} catch (error) {
		if (isMissingTableError(error)) {
			return {
				success: false,
				error: {
					code: "COLLECTION_NOT_FOUND",
					message: `Collection '${collection}' not found`,
				},
			};
		}
		console.error("Content authors error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_AUTHORS_ERROR",
				message: "Failed to list content authors",
			},
		};
	}
}

/**
 * Get single content item
 */
export async function handleContentGet(
	db: Kysely<Database>,
	collection: string,
	id: string,
	locale?: string,
	referenceOptions?: { includeDrafts: boolean },
): Promise<ApiResult<ContentResponse>> {
	try {
		const repo = new ContentRepository(db);
		const item = await repo.findByIdOrSlug(
			collection,
			id,
			locale ? resolveConfiguredLocale(locale) : undefined,
		);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		// Hydrate SEO data if the collection has SEO enabled
		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);
		await hydrateBylines(db, collection, item);
		// Opt-in: hydration is skipped entirely unless the caller passes
		// `referenceOptions`, since it can leak draft child ids/slugs — see
		// `hydrateReferences`'s doc comment.
		if (referenceOptions) {
			await hydrateReferences(db, collection, item, referenceOptions.includeDrafts);
		}

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		console.error("Content get error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_GET_ERROR",
				message: "Failed to get content",
			},
		};
	}
}

/**
 * Get a content item by id, including trashed items.
 * Used by restore endpoint for ownership checks on soft-deleted items.
 */
export async function handleContentGetIncludingTrashed(
	db: Kysely<Database>,
	collection: string,
	id: string,
	locale?: string,
): Promise<ApiResult<ContentResponse>> {
	try {
		const repo = new ContentRepository(db);
		const item = await repo.findByIdOrSlugIncludingTrashed(
			collection,
			id,
			locale ? resolveConfiguredLocale(locale) : undefined,
		);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		// Hydrate SEO data if the collection has SEO enabled
		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);
		await hydrateBylines(db, collection, item);

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		console.error("Content get error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_GET_ERROR",
				message: "Failed to get content",
			},
		};
	}
}

/**
 * Create content item.
 *
 * Content + SEO writes are wrapped in a transaction so either both succeed
 * or neither does. If `body.seo` is provided for a non-SEO collection, the
 * API returns a validation error rather than silently dropping it.
 */
export async function handleContentCreate(
	db: Kysely<Database>,
	collection: string,
	body: {
		data: Record<string, unknown>;
		slug?: string | null;
		status?: string;
		authorId?: string;
		bylines?: ContentBylineInput[];
		locale?: string;
		translationOf?: string;
		seo?: ContentSeoInput;
		taxonomies?: Record<string, string[]>;
		/** Reference fields: field slug → ordered selected entry ids. */
		references?: Record<string, string[]>;
		createdAt?: string | null;
		publishedAt?: string | null;
	},
): Promise<ApiResult<ContentResponse>> {
	try {
		const hasSeo = await collectionHasSeo(db, collection);

		// Reject SEO input for non-SEO collections
		if (body.seo && !hasSeo) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: `Collection "${collection}" does not have SEO enabled. Remove the seo field or enable SEO on this collection.`,
				},
			};
		}

		const storagelessKeys = await storagelessDataKeys(db, collection, body.data);
		if (storagelessKeys.length > 0) return storagelessDataKeyError(storagelessKeys);

		const mimeCheck = await validateMediaFields(db, collection, body.data);
		if (!mimeCheck.success) return mimeCheck;

		const requiredReferences = await validateRequiredReferencesPresent(
			db,
			collection,
			body.references,
			body.translationOf,
		);
		if (!requiredReferences.success) return requiredReferences;

		// Wrap content + SEO writes in a transaction for atomicity
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const bylineRepo = new BylineRepository(trx);
			const inheritedFields = body.translationOf
				? (
						await trx
							.selectFrom("_emdash_fields as field")
							.innerJoin(
								"_emdash_collections as collection",
								"collection.id",
								"field.collection_id",
							)
							.select("field.slug")
							.where("collection.slug", "=", collection)
							.where("field.translatable", "=", 0)
							.execute()
					).map((field) => field.slug)
				: [];

			// Resolve the whole selection before the entry is written. On D1 the
			// statements below land one at a time with nothing to roll them back, so
			// a field slug or a selected id that fails to resolve has to fail here,
			// while the only thing written is nothing.
			const referenceWrites: ResolvedReferenceTargets[] = [];
			if (body.references) {
				// A new translation joins the source's group, which may already hold
				// links the far-side count must discount.
				const entryGroup = body.translationOf
					? ((await repo.findById(collection, body.translationOf))?.translationGroup ?? null)
					: null;
				for (const [fieldSlug, selectedIds] of Object.entries(body.references)) {
					const resolved = await resolveReferenceSelectionTargets(
						trx,
						collection,
						fieldSlug,
						selectedIds,
						entryGroup,
					);
					if (!resolved.success) {
						throw Object.assign(new Error(resolved.error.message), {
							apiError: { code: resolved.error.code },
						});
					}
					referenceWrites.push(resolved.data);
				}
			}

			// Default to the configured site locale rather than the repo's
			// hard-coded "en" — otherwise non-English default-locale sites
			// silently create entries in a locale the editor never chose.
			const effectiveLocale = body.locale
				? resolveConfiguredLocale(body.locale)
				: getI18nConfig()?.defaultLocale;

			let slug: string | null | undefined = body.slug;
			if (!slug) {
				const slugSource = getSlugSource(body.data);
				if (slugSource) {
					slug = await repo.generateUniqueSlug(collection, slugSource, effectiveLocale);
				}
			}
			if (body.status === "published") {
				const publishConfig = await getCollectionPublishConfig(trx, collection);
				requireRoutablePublishSlug(publishConfig.routable, slug);
			}

			const created = await repo.create({
				type: collection,
				slug,
				data: body.data,
				status: body.status || "draft",
				authorId: body.authorId,
				locale: effectiveLocale,
				translationOf: body.translationOf,
				inheritFields: inheritedFields,
				createdAt: body.createdAt,
				publishedAt: body.publishedAt,
			});

			if (body.bylines !== undefined) {
				const credits = await bylineRepo.setContentBylines(collection, created.id, body.bylines);
				// `setContentBylines` translates wire row ids to their
				// `translation_group` before writing. The response-shape
				// `primaryBylineId` must match what's now in the DB, so read
				// it from the returned credit (whose `byline` came from a
				// hydration round-trip).
				created.primaryBylineId = credits[0]?.byline.translationGroup ?? null;
			}

			// Taxonomy assignments already belong to the content translation
			// group. Byline credits remain per content row and need copying.
			// Explicit `body.bylines` wins — `copyContentBylines` no-ops
			// when the target already has credits, but the cleaner guard
			// is to skip the call entirely.
			if (body.translationOf) {
				if (body.bylines === undefined) {
					await bylineRepo.copyContentBylines(collection, body.translationOf, created.id);
					// `copyContentBylines` writes the source's primary
					// pointer onto the new row; reflect it in-memory so the
					// response includes it before hydrateBylines runs.
					const source = await repo.findById(collection, body.translationOf);
					if (source) created.primaryBylineId = source.primaryBylineId;
				}
			}

			await hydrateBylines(trx, collection, created);

			// Side-write SEO data if provided
			if (body.seo && hasSeo) {
				const seoRepo = new SeoRepository(trx);
				created.seo = await seoRepo.upsert(collection, created.id, body.seo);
			} else if (hasSeo) {
				// Assign defaults in-memory — no DB round-trip needed
				created.seo = { ...SEO_DEFAULTS };
			}

			// Attach taxonomy terms in the same transaction. The MCP tool
			// (and the REST create body) previously accepted a `taxonomies`
			// field on `content_create` without doing anything with it, so
			// agents publishing a categorized/tagged entry had to make N
			// follow-up REST calls per taxonomy. This resolves each slug in
			// the entry's locale and pipes it through the same
			// `setTermsForEntry` path the `.../terms/{taxonomy}` REST route
			// uses, so the two entry points can't drift.
			if (body.taxonomies) {
				await assignTaxonomies(trx, collection, created.id, effectiveLocale, body.taxonomies);
			}

			// Attach the links resolved above. Nothing here can fail on the
			// caller's input any more, so the entry cannot be left written with a
			// selection that was rejected.
			if (created.translationGroup) {
				for (const write of referenceWrites) {
					await writeReferenceSelection(trx, {
						...write,
						entryGroup: created.translationGroup,
					});
				}
			}

			return created;
		});

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		// Handle structured errors thrown from inside the transaction (e.g. a
		// reference resolution failure from `setReferenceSelection`).
		if (hasApiError(error)) {
			return {
				success: false,
				error: { code: error.apiError.code, message: error.message },
			};
		}
		if (isMissingTableError(error)) {
			return {
				success: false,
				error: {
					code: "COLLECTION_NOT_FOUND",
					message: `Collection '${collection}' not found`,
				},
			};
		}
		if (error instanceof EmDashValidationError) {
			if (error.message === "Translation source content not found") {
				return {
					success: false,
					error: { code: "NOT_FOUND", message: error.message },
				};
			}
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: error.message },
			};
		}
		// SQLite UNIQUE constraint OR Postgres unique_violation — slug
		// collisions and any other unique violations land here. Match
		// specifically on "unique constraint failed" / "duplicate key" so we
		// don't false-positive on NOT NULL or CHECK violations whose
		// messages also contain "constraint failed".
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		if (message.includes("unique constraint failed") || message.includes("duplicate key")) {
			if (
				message.includes("active_tg_locale") ||
				(message.includes("translation_group") && message.includes("locale"))
			) {
				const locale = body.locale ?? getI18nConfig()?.defaultLocale ?? "en";
				return {
					success: false,
					error: {
						code: "CONFLICT",
						message: `Translation already exists in locale "${locale}" for this content item`,
					},
				};
			}
			// Detect slug-specific collisions by message fingerprint
			if (message.includes("slug")) {
				return {
					success: false,
					error: {
						code: "SLUG_CONFLICT",
						message: `Slug '${body.slug ?? "(auto-generated)"}' already exists in collection '${collection}'`,
					},
				};
			}
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: "Unique constraint violation",
				},
			};
		}
		console.error("Content create error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_CREATE_ERROR",
				message: "Failed to create content",
			},
		};
	}
}

/**
 * Update content item.
 * If `_rev` is provided, validates it against the current version before writing.
 * No `_rev` = blind write (backwards-compatible for admin UI).
 *
 * Content + SEO writes are wrapped in a transaction for atomicity.
 */
export async function handleContentUpdate(
	db: Kysely<Database>,
	collection: string,
	id: string,
	body: {
		data?: Record<string, unknown>;
		slug?: string | null;
		status?: string;
		authorId?: string | null;
		bylines?: ContentBylineInput[];
		locale?: string;
		_rev?: string;
		seo?: ContentSeoInput;
		taxonomies?: Record<string, string[]>;
		/** Reference fields: field slug → ordered selected entry ids. */
		references?: Record<string, string[]>;
		publishedAt?: string | null;
	},
): Promise<ApiResult<ContentResponse>> {
	try {
		const hasSeo = await collectionHasSeo(db, collection);

		// Reject SEO input for non-SEO collections
		if (body.seo && !hasSeo) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: `Collection "${collection}" does not have SEO enabled. Remove the seo field or enable SEO on this collection.`,
				},
			};
		}

		if (body.data) {
			const mimeCheck = await validateMediaFields(db, collection, body.data);
			if (!mimeCheck.success) return mimeCheck;
		}

		const repo = new ContentRepository(db);

		// Resolve slug → ID if needed
		const resolvedId = (await resolveId(repo, collection, id, body.locale)) ?? id;

		if (body.data) {
			const storagelessKeys = await storagelessDataKeys(db, collection, body.data);
			if (storagelessKeys.length > 0) {
				const stored = await repo.findById(collection, resolvedId);
				const changed = changedStoragelessDataKeys(
					new Set(storagelessKeys),
					body.data,
					stored?.data ?? {},
				);
				if (changed.length > 0) return storagelessDataKeyError(changed);
			}
		}

		// Wrap content + SEO writes in a transaction for atomicity.
		// The _rev check is inside the transaction so the read-then-write
		// is atomic -- no concurrent write can slip between the check and update.
		const item = await withTransaction(db, async (trx) => {
			const trxRepo = new ContentRepository(trx);
			const bylineRepo = new BylineRepository(trx);

			// Read existing item once for both _rev check and old slug capture
			const existing =
				body._rev || body.slug !== undefined || body.status === "published"
					? await trxRepo.findById(collection, resolvedId)
					: null;

			// Validate _rev if provided (optimistic concurrency)
			if (body._rev) {
				if (!existing) {
					throw Object.assign(new Error(`Content item not found: ${id}`), {
						apiError: { code: "NOT_FOUND" as const },
					});
				}

				const revCheck = validateRev(body._rev, existing);
				if (!revCheck.valid) {
					throw Object.assign(new Error(revCheck.message), {
						apiError: { code: "CONFLICT" as const },
					});
				}
			}

			// Capture old slug before update for auto-redirect
			let oldSlug: string | undefined;
			if (body.slug && existing?.slug && existing.slug !== body.slug) {
				oldSlug = existing.slug;
			}

			const resultingStatus = body.status ?? existing?.status;
			if (resultingStatus === "published") {
				if (!existing) {
					throw Object.assign(new Error(`Content item not found: ${id}`), {
						apiError: { code: "NOT_FOUND" as const },
					});
				}
				const publishConfig = await getCollectionPublishConfig(trx, collection);
				const intendedSlug = body.slug !== undefined ? body.slug : existing.slug;
				requireRoutablePublishSlug(publishConfig.routable, intendedSlug);
			}

			// Resolve the whole selection before the update, for the reason the
			// matching block in `handleContentCreate` gives: on D1 the columns,
			// bylines and SEO below are committed one statement at a time, and a
			// reference rejected after them cannot take them back.
			const referenceWrites: ReferenceSelectionWrite[] = [];
			if (body.references) {
				for (const [fieldSlug, selectedIds] of Object.entries(body.references)) {
					const resolved = await resolveReferenceSelection(
						trx,
						collection,
						resolvedId,
						fieldSlug,
						selectedIds,
					);
					if (!resolved.success) {
						throw Object.assign(new Error(resolved.error.message), {
							apiError: { code: resolved.error.code },
						});
					}
					referenceWrites.push(resolved.data);
				}
			}

			const updated = await trxRepo.update(collection, resolvedId, {
				data: body.data,
				slug: body.slug,
				status: body.status,
				authorId: body.authorId,
				publishedAt: body.publishedAt,
			});

			if (body.bylines !== undefined) {
				const credits = await bylineRepo.setContentBylines(collection, resolvedId, body.bylines);
				// `setContentBylines` translates wire row ids to their
				// `translation_group` before writing. Read the in-memory
				// pointer from the persisted credit so the response shape
				// matches the DB. See the matching block in handleContentCreate.
				updated.primaryBylineId = credits[0]?.byline.translationGroup ?? null;
			}

			// Create auto-redirect when slug changes. Date tokens in the URL
			// pattern resolve from the publish date, so the old URL uses the
			// pre-update date (the URL that was actually live) and the new URL
			// the post-update one.
			if (oldSlug && body.slug) {
				await createSlugChangeRedirect(
					trx,
					collection,
					oldSlug,
					body.slug,
					resolvedId,
					existing?.publishedAt ?? null,
					updated.publishedAt ?? null,
				);
			}

			// Sync non-translatable fields to sibling locales in the same
			// translation group. Only runs when i18n is enabled, data was updated,
			// and the item belongs to a translation group with siblings.
			if (isI18nEnabled() && body.data && updated.translationGroup) {
				await trxRepo.syncNonTranslatableFields(
					collection,
					updated.id,
					updated.translationGroup,
					body.data,
				);
			}

			// Side-write SEO data if provided, always hydrate for SEO-enabled collections
			if (body.seo && hasSeo) {
				const seoRepo = new SeoRepository(trx);
				updated.seo = await seoRepo.upsert(collection, resolvedId, body.seo);
			} else if (hasSeo) {
				const seoRepo = new SeoRepository(trx);
				updated.seo = await seoRepo.get(collection, resolvedId);
			}

			await hydrateBylines(trx, collection, updated);

			// Replace taxonomy assignments in the same transaction. Uses the
			// entry's own locale (post-update) to resolve slugs so an update
			// that also changes locale still lands on the correct term
			// variants. See handleContentCreate for rationale.
			if (body.taxonomies) {
				await assignTaxonomies(
					trx,
					collection,
					resolvedId,
					updated.locale ?? body.locale,
					body.taxonomies,
				);
			}

			// Replace the links from the selection resolved above.
			for (const write of referenceWrites) {
				await writeReferenceSelection(trx, write);
			}

			return updated;
		});

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		// Handle structured errors thrown from inside the transaction
		// (rev check failures, not-found)
		if (hasApiError(error)) {
			return {
				success: false,
				error: { code: error.apiError.code, message: error.message },
			};
		}
		if (isMissingTableError(error)) {
			return {
				success: false,
				error: {
					code: "COLLECTION_NOT_FOUND",
					message: `Collection '${collection}' not found`,
				},
			};
		}
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: error.message },
			};
		}
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		if (message.includes("unique constraint failed") || message.includes("duplicate key")) {
			if (message.includes("slug")) {
				return {
					success: false,
					error: {
						code: "SLUG_CONFLICT",
						message: `Slug '${body.slug ?? id}' already exists in collection '${collection}'`,
					},
				};
			}
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: "Unique constraint violation",
				},
			};
		}
		console.error("Content update error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_UPDATE_ERROR",
				message: "Failed to update content",
			},
		};
	}
}

/**
 * Duplicate content item.
 *
 * Only copies SEO data if the collection has SEO enabled.
 * Always returns consistent `seo` shape for SEO-enabled collections.
 */
export async function handleContentDuplicate(
	db: Kysely<Database>,
	collection: string,
	id: string,
	authorId?: string,
): Promise<ApiResult<{ item: ContentItem }>> {
	try {
		const hasSeo = await collectionHasSeo(db, collection);

		// Wrap duplicate + SEO copy in a transaction for atomicity
		const duplicate = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const bylineRepo = new BylineRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			const original = await repo.findById(collection, resolvedId);
			const dup = await repo.duplicate(collection, resolvedId, authorId);

			// Reference edges are storage-less (keyed by translation_group, not in
			// `data`), so they don't ride along in the row copy — carry the original's
			// outgoing references onto the duplicate explicitly.
			if (original?.translationGroup && dup.translationGroup) {
				const relations = new RelationRepository(trx);
				// A relation's limits bind a copied edge like any other, and a
				// selection the copy cannot hold is not one to drop quietly: the
				// duplicate would look complete with a reference field the editor
				// never emptied. Refuse instead, and name what refused it.
				throwIfReferenceLimitRefused(
					await relations.copyParentEdges(original.translationGroup, dup.translationGroup),
					"parent",
				);

				// Where a field on this collection binds the *child* end, its
				// backlinks are the field's value, so a duplicate that dropped them
				// would lose that field's whole selection. Backlinks no field views
				// still point only at the original.
				for (const field of (await referenceFieldConstraints(trx, collection)).values()) {
					if (field.relationSide !== "child") continue;
					const parents = await relations.getParents(field.relation, original.translationGroup);
					if (parents.length === 0) continue;
					throwIfReferenceLimitRefused(
						await relations.setParents(
							field.relation,
							dup.translationGroup,
							parents.map((parent) => parent.parentGroup),
						),
						"child",
					);
				}
			}

			const existingBylines = await bylineRepo.getContentBylines(collection, resolvedId);
			if (existingBylines.length > 0) {
				await bylineRepo.setContentBylines(
					collection,
					dup.id,
					existingBylines.map((entry) => ({
						bylineId: entry.byline.id,
						roleLabel: entry.roleLabel,
					})),
				);
			}

			if (hasSeo) {
				// Copy SEO data from the original (clears canonical)
				const seoRepo = new SeoRepository(trx);
				await seoRepo.copyForDuplicate(collection, resolvedId, dup.id);
				// Always hydrate SEO for consistent response shape
				dup.seo = await seoRepo.get(collection, dup.id);
			}

			await hydrateBylines(trx, collection, dup);

			return dup;
		});

		return {
			success: true,
			data: { item: duplicate },
		};
	} catch (err) {
		if (err instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: err.message,
				},
			};
		}
		// A relation limit that refused a copied edge names the entry that refused
		// it, which the editor needs to act on.
		if (hasApiError(err)) {
			return {
				success: false,
				error: { code: err.apiError.code, message: err.message },
			};
		}
		console.error("Content duplicate error:", err);
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
 * Delete content item (soft delete - moves to trash)
 */
export async function handleContentDelete(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<ApiResult<{ deleted: true; id: string }>> {
	try {
		const result = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			const deleted = await repo.delete(collection, resolvedId);
			if (deleted) {
				await new EntryLockRepository(trx).releaseEntry(collection, resolvedId);
			}
			return { id: resolvedId, deleted };
		});

		if (!result.deleted) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		return {
			success: true,
			data: { deleted: true, id: result.id },
		};
	} catch (error) {
		console.error("Content delete error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_DELETE_ERROR",
				message: "Failed to delete content",
			},
		};
	}
}

/**
 * Restore content item from trash
 */
export async function handleContentRestore(
	db: Kysely<Database>,
	collection: string,
	id: string,
	options: { _rev?: string } = {},
): Promise<ApiResult<{ restored: true; item: ContentItem; _rev: string }>> {
	try {
		const expectedRevision = decodeRevisionPrecondition(options._rev);
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveIdIncludingTrashed(repo, collection, id)) ?? id;
			return repo.restore(collection, resolvedId, expectedRevision);
		});

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Trashed content item not found: ${id}`,
				},
			};
		}

		return {
			success: true,
			data: { restored: true, item, _rev: encodeRev(item) },
		};
	} catch (error) {
		if (error instanceof ContentMutationConflictError) {
			return {
				success: false,
				error: { code: "CONFLICT", message: error.message },
			};
		}
		if (isTranslationLocaleConflict(error, collection)) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: "An active translation already exists in this locale",
				},
			};
		}
		console.error("Content restore error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_RESTORE_ERROR",
				message: "Failed to restore content",
			},
		};
	}
}

/**
 * Permanently delete content item (cannot be undone).
 * Also cleans up associated SEO data.
 */
export async function handleContentPermanentDelete(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<ApiResult<{ deleted: true; id: string }>> {
	try {
		const repo = new ContentRepository(db);
		const resolvedId = (await resolveIdIncludingTrashed(repo, collection, id)) ?? id;

		// Wrap content delete + SEO/comment cleanup in a transaction
		const deleted = await withTransaction(db, async (trx) => {
			const trxRepo = new ContentRepository(trx);
			const item = await trxRepo.findByIdIncludingTrashed(collection, resolvedId);

			// `permanentDelete` removes a trashed row only. Anything cleared ahead of
			// it has to answer the same question first, or purging a live entry strips
			// what belongs to it and then reports it was never found — and nothing
			// throws, so the clear stands even where the transaction is real.
			if (!item || item.deletedAt === null) return false;

			// Term assignments and reference edges are keyed by translation_group, so
			// they belong to the group rather than to this row. They go only once no
			// row of the group is left, trashed ones included, since a trashed row
			// can still be restored.
			const lastOfGroup =
				item.translationGroup !== null
					? !(await trxRepo.hasTranslationsIncludingTrashed(collection, item.translationGroup, {
							excludeId: resolvedId,
						}))
					: false;

			// The edges go before the row does. On D1 the delete below is committed
			// on its own, and this row is the only way back to the group that names
			// them — a cleanup that failed after it would strand edges that still
			// count and still show up as backlinks, with nothing left to find them
			// by. Failing here instead leaves everything as it was, to retry.
			if (lastOfGroup && item.translationGroup) {
				await new RelationRepository(trx).clearReferencesForGroup(item.translationGroup);
			}

			const wasDeleted = await trxRepo.permanentDelete(collection, resolvedId);

			if (wasDeleted) {
				// Clean up SEO data for permanently deleted content
				const seoRepo = new SeoRepository(trx);
				await seoRepo.delete(collection, resolvedId);
				// Clean up comments for permanently deleted content
				const commentRepo = new CommentRepository(trx);
				await commentRepo.deleteByContent(collection, resolvedId);
				// Clean up revisions for permanently deleted content
				const revisionRepo = new RevisionRepository(trx);
				await revisionRepo.deleteByEntry(collection, resolvedId);
				await new EntryLockRepository(trx).releaseEntry(collection, resolvedId);
				// Credits belong to this row alone — no other row reads them, so they
				// go with it whether or not the group survives.
				await new BylineRepository(trx).deleteContentBylines(collection, resolvedId);
				if (lastOfGroup && item.translationGroup) {
					await new TaxonomyRepository(trx).clearEntryGroupTerms(collection, item.translationGroup);
				}
			}

			return wasDeleted;
		});

		if (!deleted) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		return {
			success: true,
			data: { deleted: true, id: resolvedId },
		};
	} catch (error) {
		console.error("Content permanent delete error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_DELETE_ERROR",
				message: "Failed to permanently delete content",
			},
		};
	}
}

/**
 * List trashed content items
 */
export async function handleContentListTrashed(
	db: Kysely<Database>,
	collection: string,
	options: { limit?: number; cursor?: string; locale?: string } = {},
): Promise<ApiResult<{ items: TrashedContentItem[]; nextCursor?: string }>> {
	try {
		const repo = new ContentRepository(db);
		const result = await repo.findTrashed(collection, {
			limit: options.limit,
			cursor: options.cursor,
			where: { locale: options.locale },
		});

		return {
			success: true,
			data: {
				items: result.items.map((item) => ({
					id: item.id,
					type: item.type,
					slug: item.slug,
					status: item.status,
					locale: item.locale,
					translationGroup: item.translationGroup,
					data: item.data,
					authorId: item.authorId,
					createdAt: item.createdAt,
					updatedAt: item.updatedAt,
					publishedAt: item.publishedAt,
					deletedAt: item.deletedAt,
				})),
				nextCursor: result.nextCursor,
			},
		};
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: { code: "INVALID_CURSOR", message: error.message },
			};
		}
		console.error("Content list trashed error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_LIST_ERROR",
				message: "Failed to list trashed content",
			},
		};
	}
}

/**
 * Count trashed content items
 */
export async function handleContentCountTrashed(
	db: Kysely<Database>,
	collection: string,
	options: { locale?: string } = {},
): Promise<ApiResult<{ count: number }>> {
	try {
		const repo = new ContentRepository(db);
		const count = await repo.countTrashed(collection, { locale: options.locale });

		return {
			success: true,
			data: { count },
		};
	} catch (error) {
		console.error("Content count trashed error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_COUNT_ERROR",
				message: "Failed to count trashed content",
			},
		};
	}
}

/**
 * Schedule content for future publishing
 */
export async function handleContentSchedule(
	db: Kysely<Database>,
	collection: string,
	id: string,
	scheduledAt: string,
	currentTime: Date = new Date(),
	_rev?: string,
): Promise<ApiResult<ContentResponse>> {
	try {
		const expectedRevision = decodeRevisionPrecondition(_rev);
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const existing = await repo.findByIdOrSlug(collection, id);
			const resolvedId = existing?.id ?? id;
			if (existing) {
				const publishConfig = await getCollectionPublishConfig(trx, collection);
				requireRoutablePublishSlug(publishConfig.routable, existing.slug);
			}
			return repo.schedule(collection, resolvedId, scheduledAt, currentTime, expectedRevision);
		});

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		if (error instanceof ContentMutationConflictError) {
			return {
				success: false,
				error: { code: "CONFLICT", message: error.message },
			};
		}
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: error.message,
				},
			};
		}
		console.error("Content schedule error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_SCHEDULE_ERROR",
				message: "Failed to schedule content",
			},
		};
	}
}

/**
 * Unschedule content (revert to draft)
 */
export async function handleContentUnschedule(
	db: Kysely<Database>,
	collection: string,
	id: string,
	options: { _rev?: string } = {},
): Promise<ApiResult<ContentResponse>> {
	try {
		const expectedRevision = decodeRevisionPrecondition(options._rev);
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			return repo.unschedule(collection, resolvedId, expectedRevision);
		});

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		if (error instanceof ContentMutationConflictError) {
			return {
				success: false,
				error: { code: "CONFLICT", message: error.message },
			};
		}
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: error.message,
				},
			};
		}
		console.error("Content unschedule error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_UNSCHEDULE_ERROR",
				message: "Failed to unschedule content",
			},
		};
	}
}

/**
 * Persist a permanent policy rejection and unschedule the publication.
 * Databases with transactions commit both writes together. D1 persists the
 * reason first so a failed option write cannot silently remove the entry from
 * future sweeps; if unscheduling then fails, the due entry and its dashboard
 * notice remain available for retry and operator action.
 */
export async function handleScheduledPolicyRejection(
	db: Kysely<Database>,
	collection: string,
	id: string,
	options: { _rev: string; rejection: ScheduledPolicyRejection },
): Promise<ApiResult<ContentResponse>> {
	try {
		const expectedRevision = decodeRevisionPrecondition(options._rev);
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			const optionsRepo = new OptionsRepository(trx);
			const rejectionKey = scheduledPolicyRejectionKey(collection, resolvedId);
			const rejectionRevision = await optionsRepo.setVersioned(rejectionKey, {
				...options.rejection,
				id: resolvedId,
			});
			try {
				return await repo.unschedule(collection, resolvedId, expectedRevision);
			} catch (error) {
				if (error instanceof ContentMutationConflictError) {
					try {
						await optionsRepo.compareAndDelete(rejectionKey, rejectionRevision);
					} catch (cleanupError) {
						console.error("Failed to clear stale scheduled policy rejection:", cleanupError);
					}
				}
				throw error;
			}
		});

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);
		return { success: true, data: { item, _rev: encodeRev(item) } };
	} catch (error) {
		if (error instanceof ContentMutationConflictError) {
			return {
				success: false,
				error: { code: "CONFLICT", message: error.message },
			};
		}
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: error.message },
			};
		}
		console.error("Scheduled policy rejection error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_UNSCHEDULE_ERROR",
				message: "Failed to record scheduled publication rejection",
			},
		};
	}
}

/**
 * Publish content immediately.
 *
 * Publication is one atomic content-row statement. On databases that support
 * transactions, the slug redirect and the locale sync stay grouped with it.
 */
export async function handleContentPublish(
	db: Kysely<Database>,
	collection: string,
	id: string,
	options: {
		publishedAt?: string;
		requireScheduledDue?: boolean;
		expectedScheduledAt?: string;
		_rev?: string;
		currentTime?: Date;
	} = {},
): Promise<ApiResult<ContentResponse>> {
	try {
		const expectedRevision = decodeRevisionPrecondition(options._rev);
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			const publishConfig = await getCollectionPublishConfig(trx, collection);

			// Capture the pre-publish state. For revision-supporting collections a
			// slug edit is staged as `_slug` in the draft revision and only lands
			// on the live `slug` column here, inside `repo.publish()` — it never
			// passes through handleContentUpdate, where slug-change auto-redirects
			// are normally created.
			const existing = await repo.findById(collection, resolvedId);

			// A selection staged in the draft becomes the live one here. Validate
			// before the publishing statement rather than after: `withTransaction`
			// degrades to sequential statements on D1, so a selection rejected
			// afterwards would leave the entry published with the old links.
			const draftRevision =
				publishConfig.supportsRevisions && existing?.draftRevisionId
					? await new RevisionRepository(trx).findById(existing.draftRevisionId)
					: undefined;
			const stagedReferences = draftRevision ? readStagedReferences(draftRevision.data) : undefined;
			if (existing?.translationGroup) {
				const valid = await validateStagedReferences(
					trx,
					collection,
					stagedReferences ?? {},
					existing.translationGroup,
				);
				if (!valid.success) {
					throw Object.assign(new Error(valid.error.message), {
						apiError: { code: valid.error.code },
					});
				}

				// Promote before the publishing statement, which is also what clears
				// the draft pointer. On D1 that statement cannot be taken back, and
				// the draft is the only place the staged selection can be read from
				// again — a promotion that failed after it would have nothing left to
				// retry. Replacing a selection is idempotent, so a retry that reaches
				// here twice writes the same links.
				//
				// That ordering only holds if the publish is going to happen, so every
				// refusal `repo.publish()` decides before it writes is decided here
				// first. It repeats them all and stays authoritative; running them
				// early keeps a refusal from landing after a promotion nothing undoes,
				// which would show readers a selection that was never published. Its
				// last check is the optimistic fence, which cannot move ahead of the
				// write it guards.
				if (stagedReferences) {
					await assertPublishWillNotBeRefused(trx, collection, resolvedId, existing, {
						stagedSlug: readStagedSlug(draftRevision?.data),
						requireSlug: publishConfig.routable,
						requireDue: options.requireScheduledDue,
						expectedScheduledAt: options.expectedScheduledAt,
						expectedRevision,
					});
					await applyStagedReferences(trx, collection, existing.translationGroup, stagedReferences);
				}
			}

			const published = await repo.publish(
				collection,
				resolvedId,
				options.publishedAt,
				options.requireScheduledDue,
				options.expectedScheduledAt,
				publishConfig.supportsRevisions,
				publishConfig.routable,
				expectedRevision,
				options.currentTime,
			);

			if (
				publishConfig.supportsRevisions &&
				published.liveRevisionId &&
				published.translationGroup
			) {
				await recordPublishedReferences(
					trx,
					collection,
					published.liveRevisionId,
					published.translationGroup,
				);
			}

			if (
				existing &&
				isI18nEnabled() &&
				publishConfig.supportsRevisions &&
				published.translationGroup
			) {
				await repo.syncNonTranslatableFields(
					collection,
					published.id,
					published.translationGroup,
					published.data,
					{ previous: existing.data },
				);
			}

			// Leave a 301 behind when publishing changed the slug of an entry that
			// was already published — its old URL was live and may be indexed or
			// linked. A first publish is excluded: a draft's URL was never public.
			if (
				existing?.status === "published" &&
				existing.slug &&
				published.slug &&
				existing.slug !== published.slug
			) {
				await createSlugChangeRedirect(
					trx,
					collection,
					existing.slug,
					published.slug,
					resolvedId,
					existing.publishedAt ?? null,
					published.publishedAt ?? null,
				);
			}

			return published;
		});

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		if (hasApiError(error)) {
			return {
				success: false,
				error: { code: error.apiError.code, message: error.message },
			};
		}
		if (error instanceof ContentMutationConflictError) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: error.message,
				},
			};
		}
		// The scheduled sweep gates publish on the row still being due; a row
		// unscheduled in the meantime is a silent skip, not a failure.
		if (error instanceof ScheduledNotDueError) {
			return {
				success: false,
				error: {
					code: "NOT_DUE",
					message: error.message,
				},
			};
		}
		if (error instanceof EmDashValidationError) {
			// The staged-slug pre-check tags its error so it maps to the same
			// 409 SLUG_CONFLICT as direct slug edits in create/update.
			const details: unknown = error.details;
			const isSlugConflict =
				typeof details === "object" &&
				details !== null &&
				"code" in details &&
				details.code === "SLUG_CONFLICT";
			return {
				success: false,
				error: {
					code: isSlugConflict ? "SLUG_CONFLICT" : "VALIDATION_ERROR",
					message: error.message,
				},
			};
		}
		// Backstop for the pre-check inside repo.publish(): a concurrent write
		// can still take the slug between the check and the UPDATE, in which
		// case the `(slug, locale)` unique constraint fires. Same fingerprint
		// mapping as create/update — never a raw SQLite error to the client.
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		if (
			(message.includes("unique constraint failed") || message.includes("duplicate key")) &&
			message.includes("slug")
		) {
			return {
				success: false,
				error: {
					code: "SLUG_CONFLICT",
					message: `The staged slug is already used by another entry in collection '${collection}'`,
				},
			};
		}
		console.error("Content publish error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_PUBLISH_ERROR",
				message: "Failed to publish content",
			},
		};
	}
}

/**
 * Unpublish content (revert to draft).
 *
 * Wrapped in a transaction — unpublish may create a draft revision
 * from the live version then update the status, which is multi-step.
 */
export async function handleContentUnpublish(
	db: Kysely<Database>,
	collection: string,
	id: string,
	options: { _rev?: string } = {},
): Promise<ApiResult<ContentResponse>> {
	try {
		const expectedRevision = decodeRevisionPrecondition(options._rev);
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			return repo.unpublish(collection, resolvedId, expectedRevision);
		});

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		if (error instanceof ContentMutationConflictError) {
			return {
				success: false,
				error: { code: "CONFLICT", message: error.message },
			};
		}
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: error.message,
				},
			};
		}
		console.error("Content unpublish error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_UNPUBLISH_ERROR",
				message: "Failed to unpublish content",
			},
		};
	}
}

/**
 * Count scheduled content items
 */
export async function handleContentCountScheduled(
	db: Kysely<Database>,
	collection: string,
): Promise<ApiResult<{ count: number }>> {
	try {
		const repo = new ContentRepository(db);
		const count = await repo.countScheduled(collection);

		return {
			success: true,
			data: { count },
		};
	} catch (error) {
		console.error("Content count scheduled error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_COUNT_ERROR",
				message: "Failed to count scheduled content",
			},
		};
	}
}

/**
 * Discard draft changes (revert to live version)
 */
export async function handleContentDiscardDraft(
	db: Kysely<Database>,
	collection: string,
	id: string,
	options: { _rev?: string } = {},
): Promise<ApiResult<ContentResponse>> {
	try {
		const expectedRevision = decodeRevisionPrecondition(options._rev);
		const item = await withTransaction(db, async (trx) => {
			const repo = new ContentRepository(trx);
			const resolvedId = (await resolveId(repo, collection, id)) ?? id;
			return repo.discardDraft(collection, resolvedId, expectedRevision);
		});

		const hasSeo = await collectionHasSeo(db, collection);
		await hydrateSeo(db, collection, item, hasSeo);

		return {
			success: true,
			data: { item, _rev: encodeRev(item) },
		};
	} catch (error) {
		if (error instanceof ContentMutationConflictError) {
			return {
				success: false,
				error: { code: "CONFLICT", message: error.message },
			};
		}
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: error.message,
				},
			};
		}
		console.error("Content discard draft error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_DISCARD_DRAFT_ERROR",
				message: "Failed to discard draft",
			},
		};
	}
}

/**
 * Compare live and draft revisions
 */
export async function handleContentCompare(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<
	ApiResult<{
		hasChanges: boolean;
		live: Record<string, unknown> | null;
		draft: Record<string, unknown> | null;
	}>
> {
	try {
		const repo = new ContentRepository(db);
		const entry = await repo.findByIdOrSlug(collection, id);

		if (!entry) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		const revisionRepo = new RevisionRepository(db);

		const live = entry.liveRevisionId ? await revisionRepo.findById(entry.liveRevisionId) : null;
		const draft = entry.draftRevisionId ? await revisionRepo.findById(entry.draftRevisionId) : null;

		// Reference selections have to be filled in from the links on both sides
		// before they can be compared. The published selection is the links, not
		// whatever `_references` the live revision happens to carry; and the draft
		// stages only the fields its saves named, so the rest of its effective
		// selection is the live one.
		const liveReferences = entry.translationGroup
			? await liveReferenceSelection(db, collection, entry.translationGroup)
			: {};
		const withReferences = (
			revisionData: Record<string, unknown> | undefined,
			staged: StagedReferences,
		) => {
			if (!revisionData) return undefined;
			const selection = { ...liveReferences, ...staged };
			if (Object.keys(selection).length === 0) return revisionData;
			return { ...revisionData, [STAGED_REFERENCES_KEY]: selection };
		};

		return {
			success: true,
			data: {
				hasChanges:
					entry.draftRevisionId !== null && entry.draftRevisionId !== entry.liveRevisionId,
				live: withReferences(live?.data, {}) ?? null,
				draft: withReferences(draft?.data, readStagedReferences(draft?.data) ?? {}) ?? null,
			},
		};
	} catch (error) {
		console.error("Content compare error:", error);
		return {
			success: false,
			error: {
				code: "CONTENT_COMPARE_ERROR",
				message: "Failed to compare revisions",
			},
		};
	}
}

/**
 * Get all translations for a content item.
 * Returns the item's translation group members with locale and status info.
 */
export async function handleContentTranslations(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<
	ApiResult<{
		translationGroup: string;
		translations: Array<{
			id: string;
			locale: string | null;
			slug: string | null;
			status: string;
			updatedAt: string;
		}>;
	}>
> {
	try {
		const repo = new ContentRepository(db);
		const item = await repo.findByIdOrSlug(collection, id);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Content item not found: ${id}`,
				},
			};
		}

		if (!item.translationGroup) {
			return {
				success: true,
				data: {
					translationGroup: item.id,
					translations: [
						{
							id: item.id,
							locale: item.locale,
							slug: item.slug,
							status: item.status,
							updatedAt: item.updatedAt,
						},
					],
				},
			};
		}

		const translations = await repo.findTranslations(collection, item.translationGroup);

		return {
			success: true,
			data: {
				translationGroup: item.translationGroup,
				translations: translations.map((t) => ({
					id: t.id,
					locale: t.locale,
					slug: t.slug,
					status: t.status,
					updatedAt: t.updatedAt,
				})),
			},
		};
	} catch (error) {
		if (error instanceof Error) {
			console.error("Content translations error:", error);
		}
		return {
			success: false,
			error: {
				code: "CONTENT_TRANSLATIONS_ERROR",
				message: "Failed to get translations",
			},
		};
	}
}

/**
 * Resolve a `{ taxonomyName: [slug, ...] }` map to term IDs and replace the
 * entry's assignments for each named taxonomy.
 *
 * Shared by handleContentCreate and handleContentUpdate so both MCP entry
 * points behave identically. Slug resolution is scoped to `locale`; passing
 * `undefined` lets `findBySlug` fall back to its default (lowest locale code)
 * so callers on single-locale sites don't need to know the site's default.
 *
 * Throws EmDashValidationError on unknown slug or wrong shape; the calling
 * handler translates that into a VALIDATION_ERROR response.
 */
async function assignTaxonomies(
	trx: Kysely<Database>,
	collection: string,
	entryId: string,
	locale: string | undefined,
	taxonomies: Record<string, string[]>,
): Promise<void> {
	const taxRepo = new TaxonomyRepository(trx);
	let anyChange = false;

	for (const [taxonomyName, slugs] of Object.entries(taxonomies)) {
		if (!Array.isArray(slugs)) {
			throw new EmDashValidationError(`taxonomies.${taxonomyName} must be an array of term slugs`);
		}

		const termIds: string[] = [];
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
			termIds.push(term.id);
		}

		await taxRepo.setTermsForEntry(collection, entryId, taxonomyName, termIds);
		anyChange = true;
	}

	// Match the REST route's behaviour: taxonomy term assignments changed,
	// so invalidate the taxonomy object cache used during hydration.
	if (anyChange) invalidateTermCache();
}
