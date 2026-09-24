/**
 * The `rebuild` stage: derived state the importer does not write row by row.
 *
 * - `search`: full-text indexes for collections whose package search config
 *   is enabled, populated in rowid ranges, then the collection's final
 *   `search_config` (SQLite only; the plan declares `search_unsupported`
 *   elsewhere).
 * - `media_usage`: every imported collection is marked stale so the
 *   media-usage maintenance engine re-indexes it.
 * - `options`: `POST_IMPORT_OPTION_RESETS`.
 * - `taxonomies`: each taxonomy's structure group, rebuilt from its imported
 *   definitions; a group whose name no definition has any more is deleted.
 * - `caches`: isolate caches and every object-cache namespace.
 */

import { sql } from "kysely";

import { isSqlite } from "../../database/dialect-helpers.js";
import { parseTaxonomyCollections } from "../../database/repositories/taxonomy-def.js";
import { markContentMediaUsageCollectionStale } from "../../media/usage/content-refresh.js";
import {
	CacheNamespace,
	invalidateCollectionCache,
	invalidateObjectCache,
} from "../../object-cache/index.js";
import { resetRegisteredCollectionsCache } from "../../schema/collection-slugs-cache.js";
import { invalidateSchemaCache } from "../../schema/zod-generator.js";
import { FTSManager } from "../../search/fts-manager.js";
import type { SearchTokenizer } from "../../search/types.js";
import { SEARCH_TOKENIZERS } from "../../search/types.js";
import { invalidateSiteSettingsCache } from "../../settings/index.js";
import { TransferError } from "../errors.js";
import { compareIds, type CollectionRecord } from "../format/kinds.js";
import { POST_IMPORT_OPTION_RESETS } from "../format/settings.js";
import { applyTransformations } from "../format/transformations.js";
import { REBUILD_STEPS, type RebuildStep } from "../ops/states.js";
import type { ImportContext } from "./context.js";
import { ulidFromHash } from "./ids.js";

const FTS_ROWS_PER_UNIT = 500;
const FTS_SETUP_STATEMENTS = 20;
const FTS_POPULATE_STATEMENTS = 4;
const STALE_STATEMENTS = 4;
const OPTION_STATEMENTS = 4;
const TAXONOMY_STATEMENTS = 4;
/** Cache invalidation runs no queries; its checkpoint does. */
const CACHE_STATEMENTS = 1;

export interface RebuildPosition {
	step: RebuildStep;
	after: string | null;
}

export type RebuildCheckpoint = (position: RebuildPosition) => Promise<void>;

/** Run rebuild units from `position`; returns null when the stage is done. */
export async function runRebuild(
	context: ImportContext,
	start: RebuildPosition,
	checkpoint: RebuildCheckpoint,
): Promise<RebuildPosition | null> {
	let position: RebuildPosition | null = start;
	while (position) {
		const next: RebuildPosition | null | "budget" = await runUnit(context, position);
		if (next === "budget") return position;
		if (next) await checkpoint(next);
		position = next;
	}
	return null;
}

function nextStep(step: RebuildStep): RebuildPosition | null {
	const following = REBUILD_STEPS[REBUILD_STEPS.indexOf(step) + 1];
	return following ? { step: following, after: null } : null;
}

async function collections(context: ImportContext): Promise<CollectionRecord[]> {
	return (await context.allRecords("collection")).toSorted((a, b) => compareIds(a.slug, b.slug));
}

async function runUnit(
	context: ImportContext,
	position: RebuildPosition,
): Promise<RebuildPosition | null | "budget"> {
	switch (position.step) {
		case "search":
			return searchUnit(context, position.after);
		case "media_usage": {
			const collection = (await collections(context)).find(
				(candidate) => position.after === null || compareIds(candidate.slug, position.after) > 0,
			);
			if (!collection) return nextStep("media_usage");
			if (!context.budget.canStart({ queries: STALE_STATEMENTS })) return "budget";
			context.budget.start();
			await markContentMediaUsageCollectionStale(
				context.db,
				collection.slug,
				"CONTENT_USAGE_STALE",
			);
			return { step: "media_usage", after: collection.slug };
		}
		case "options": {
			if (!context.budget.canStart({ queries: OPTION_STATEMENTS })) return "budget";
			context.budget.start();
			for (const name of POST_IMPORT_OPTION_RESETS.bumpVersion) {
				await sql`
					INSERT INTO options (name, value)
					VALUES (${name}, '2')
					ON CONFLICT(name) DO UPDATE SET value = CASE
						WHEN CAST(options.value AS INTEGER) % 2 = 0
							THEN CAST(CAST(options.value AS INTEGER) + 2 AS TEXT)
						ELSE CAST(CAST(options.value AS INTEGER) + 1 AS TEXT)
					END
				`.execute(context.db);
			}
			await context.db
				.deleteFrom("options")
				.where("name", "in", [...POST_IMPORT_OPTION_RESETS.delete])
				.execute();
			return nextStep("options");
		}
		case "taxonomies":
			return taxonomyUnit(context, position.after);
		case "caches":
			if (!context.budget.canStart({ queries: CACHE_STATEMENTS })) return "budget";
			context.budget.start();
			await invalidateCaches(context);
			return nextStep("caches");
	}
}

function isTokenizer(value: unknown): value is SearchTokenizer {
	return SEARCH_TOKENIZERS.some((tokenizer) => tokenizer === value);
}

interface SearchTarget {
	record: CollectionRecord;
	config: Record<string, unknown>;
}

async function searchTargets(context: ImportContext): Promise<SearchTarget[]> {
	const targets: SearchTarget[] = [];
	for (const record of await collections(context)) {
		const final = applyTransformations(record, context.plan, { fieldColumnTypes: new Map() });
		const config = final.searchConfig;
		if (typeof config !== "object" || config === null || Array.isArray(config)) continue;
		if (config.enabled !== true) continue;
		if (!isSqlite(context.db)) {
			throw new TransferError(
				"TRANSFER_IMPORT_ERROR",
				"Full-text search is not available on this target",
				{ detail: { kind: "collection", id: record.id } },
			);
		}
		targets.push({ record, config });
	}
	return targets;
}

/** `after`: null, `slug` (done), or `slug:rowid` (index created, rows ≤ rowid indexed). */
async function searchUnit(
	context: ImportContext,
	after: string | null,
): Promise<RebuildPosition | null | "budget"> {
	const [doneSlug, rowidText] = after?.split(":") ?? [];
	const inProgress = rowidText === undefined ? null : Number(rowidText);
	const target = (await searchTargets(context)).find((candidate) =>
		inProgress === null
			? doneSlug === undefined || compareIds(candidate.record.slug, doneSlug) > 0
			: candidate.record.slug === doneSlug,
	);
	if (!target) return nextStep("search");
	const slug = target.record.slug;
	const fts = new FTSManager(context.db);

	if (inProgress === null) {
		if (!context.budget.canStart({ queries: FTS_SETUP_STATEMENTS })) return "budget";
		context.budget.start();
		const fields = await fts.getSearchableFields(slug);
		if (fields.length > 0) {
			const weights = target.config.weights;
			await fts.dropFtsTable(slug);
			await fts.createFtsTable(
				slug,
				fields,
				typeof weights === "object" && weights !== null
					? Object.fromEntries(
							Object.entries(weights).filter(
								(entry): entry is [string, number] => typeof entry[1] === "number",
							),
						)
					: undefined,
				isTokenizer(target.config.tokenize) ? target.config.tokenize : undefined,
			);
		}
		return { step: "search", after: `${slug}:0` };
	}

	if (!context.budget.canStart({ queries: FTS_POPULATE_STATEMENTS })) return "budget";
	context.budget.start();
	const fields = await fts.getSearchableFields(slug);
	const last =
		fields.length > 0 ? await fts.populateRange(slug, fields, inProgress, FTS_ROWS_PER_UNIT) : null;
	if (last !== null) return { step: "search", after: `${slug}:${last}` };
	await context.db
		.updateTable("_emdash_collections")
		.set({ search_config: JSON.stringify(target.config) })
		.where("id", "=", target.record.id)
		.execute();
	return { step: "search", after: slug };
}

/**
 * `after`: the last taxonomy name whose group was rebuilt, or null.
 *
 * The group becomes hierarchical if any definition is and lists every collection
 * any definition lists. The definitions keep the package's values, which the
 * verify stage compares; they differ from the group only where the exporting
 * site's locales disagreed.
 */
async function taxonomyUnit(
	context: ImportContext,
	after: string | null,
): Promise<RebuildPosition | null | "budget"> {
	if (!context.budget.canStart({ queries: TAXONOMY_STATEMENTS })) return "budget";
	context.budget.start();
	const db = context.db;
	let nextName = db
		.selectFrom("_emdash_taxonomy_defs")
		.select((eb) => eb.fn.min("name").as("name"));
	if (after !== null) nextName = nextName.where("name", ">", after);
	const defs = await db
		.selectFrom("_emdash_taxonomy_defs")
		.select(["id", "name", "hierarchical", "collections", "translation_group"])
		.where("name", "=", nextName)
		.orderBy("id")
		.execute();
	const name = defs[0]?.name;
	if (name === undefined) {
		await db
			.deleteFrom("_emdash_taxonomy_def_groups")
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("_emdash_taxonomy_defs")
							.select(sql`1`.as("one"))
							.whereRef("_emdash_taxonomy_defs.name", "=", "_emdash_taxonomy_def_groups.name"),
					),
				),
			)
			.execute();
		return nextStep("taxonomies");
	}

	const groupId = defs
		.map((def) => def.translation_group ?? def.id)
		.reduce((lowest, candidate) => (candidate < lowest ? candidate : lowest));
	const collectionSlugs = [
		...new Set(defs.flatMap((def) => parseTaxonomyCollections(def.collections))),
	];
	const hierarchical = defs.some((def) => def.hierarchical === 1) ? 1 : 0;
	const taken = await db
		.selectFrom("_emdash_taxonomy_def_groups")
		.select("id")
		.where("id", "=", groupId)
		.where("name", "!=", name)
		.executeTakeFirst();
	const id = taken ? await ulidFromHash(context.operationId, "taxonomy_group", name) : groupId;
	await db
		.insertInto("_emdash_taxonomy_def_groups")
		.values({ id, name, hierarchical, collections: JSON.stringify(collectionSlugs) })
		.onConflict((oc) =>
			oc
				.column("name")
				.doUpdateSet({ id, hierarchical, collections: JSON.stringify(collectionSlugs) }),
		)
		.execute();
	return { step: "taxonomies", after: name };
}

async function invalidateCaches(context: ImportContext): Promise<void> {
	for (const namespace of Object.values(CacheNamespace)) invalidateObjectCache(namespace);
	for (const collection of await collections(context)) {
		invalidateCollectionCache(collection.slug);
		invalidateSchemaCache(collection.slug);
	}
	invalidateSiteSettingsCache();
	resetRegisteredCollectionsCache();
	const { invalidateTermCache, invalidateTaxonomyDefsCache } =
		await import("../../taxonomies/index.js");
	const { invalidateBylineCache } = await import("../../bylines/index.js");
	const { invalidateRedirectCache } = await import("../../redirects/cache.js");
	const { invalidateUrlPatternCache } = await import("../../query.js");
	invalidateTermCache();
	invalidateTaxonomyDefsCache();
	invalidateBylineCache();
	invalidateRedirectCache();
	invalidateUrlPatternCache();
}
