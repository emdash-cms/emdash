/**
 * The `clear_scaffold` stage: delete the seeded scaffold the plan declared
 * (`seeded_scaffold_removed`), one item per unit, then wait until
 * media-usage collection deletions of removed collections have finished so
 * the package may reuse their slugs.
 */

import { sql } from "kysely";

import { processDueMediaUsageCollectionDeletions } from "../../media/usage/collection-deletion-processor.js";
import { SchemaError, SchemaRegistry } from "../../schema/registry.js";
import { TransferError } from "../errors.js";
import type { ImportTransformation } from "../format/transformations.js";
import type { ImportContext } from "./context.js";

export type ScaffoldItemRef = Extract<
	ImportTransformation,
	{ code: "seeded_scaffold_removed" }
>["items"][number];

const ITEM_STATEMENTS = 40;

export function declaredScaffold(context: ImportContext): readonly ScaffoldItemRef[] {
	return context.plan.transformations.flatMap((transformation) =>
		transformation.code === "seeded_scaffold_removed" ? transformation.items : [],
	);
}

export type ScaffoldProgress =
	| { state: "continue"; step: number }
	| { state: "wait"; step: number }
	| { state: "done" };

/**
 * Delete declared items from `step` on. Each item is removed only if it is
 * still the scaffold it was when analyzed (an unassigned term, an empty menu,
 * an empty widget area, a theme section, a seeded block type); deleting an already-deleted item
 * is a no-op.
 */
export async function clearScaffold(
	context: ImportContext,
	step: number,
	checkpoint: (step: number) => Promise<void>,
): Promise<ScaffoldProgress> {
	const items = declaredScaffold(context);
	let next = step;
	while (next < items.length) {
		const item = items[next];
		if (!item) break;
		if (!context.budget.canStart({ queries: ITEM_STATEMENTS })) {
			return { state: "continue", step: next };
		}
		context.budget.start();
		await removeItem(context, item);
		next++;
		await checkpoint(next);
	}

	const collectionIds = items.flatMap((item) => (item.type === "collection" ? [item.id] : []));
	while (collectionIds.length > 0) {
		if (!context.budget.canStart({ queries: ITEM_STATEMENTS })) {
			return { state: "continue", step: next };
		}
		context.budget.start();
		const pending = await context.db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.select("collection_id")
			.where("collection_id", "in", collectionIds)
			.execute();
		if (pending.length === 0) break;
		const tick = await processDueMediaUsageCollectionDeletions(context.db);
		if (tick.outcome === "idle" || tick.outcome === "claim_lost" || tick.outcome === "retry") {
			return { state: "wait", step: next };
		}
		if (tick.outcome === "failed") {
			throw new TransferError(
				"TRANSFER_IMPORT_ERROR",
				"Removing the seeded scaffold collections failed",
			);
		}
	}
	return { state: "done" };
}

async function removeItem(context: ImportContext, item: ScaffoldItemRef): Promise<void> {
	const db = context.db;
	switch (item.type) {
		case "collection": {
			const row =
				(await db
					.selectFrom("_emdash_collections")
					.select("slug")
					.where("id", "=", item.id)
					.executeTakeFirst()) ??
				(await db
					.selectFrom("_emdash_media_usage_collection_deletions")
					.select("collection_slug as slug")
					.where("collection_id", "=", item.id)
					.executeTakeFirst());
			if (!row) return;
			try {
				await new SchemaRegistry(db).deleteCollection(row.slug);
			} catch (error) {
				if (error instanceof SchemaError && error.code === "COLLECTION_NOT_FOUND") return;
				if (error instanceof SchemaError) {
					throw new TransferError("TRANSFER_TARGET_NOT_EMPTY", "Scaffold collection is in use", {
						detail: { type: item.type, id: item.id, reason: error.code },
						cause: error,
					});
				}
				throw error;
			}
			return;
		}
		case "term":
			await db
				.deleteFrom("taxonomies")
				.where("id", "=", item.id)
				.where((eb) =>
					eb.not(
						eb.exists(
							eb
								.selectFrom("content_taxonomies")
								.select(sql`1`.as("one"))
								.where(
									"content_taxonomies.taxonomy_id",
									"=",
									eb.fn.coalesce("taxonomies.translation_group", "taxonomies.id"),
								),
						),
					),
				)
				.execute();
			return;
		case "menu_item":
			await db.deleteFrom("_emdash_menu_items").where("id", "=", item.id).execute();
			return;
		case "widget":
			await db.deleteFrom("_emdash_widgets").where("id", "=", item.id).execute();
			return;
		case "taxonomy_def":
			await db
				.deleteFrom("_emdash_taxonomy_defs")
				.where("id", "=", item.id)
				.where((eb) =>
					eb.not(
						eb.exists(
							eb
								.selectFrom("taxonomies")
								.select(sql`1`.as("one"))
								.whereRef("taxonomies.name", "=", "_emdash_taxonomy_defs.name"),
						),
					),
				)
				.execute();
			return;
		case "menu":
			await db
				.deleteFrom("_emdash_menus")
				.where("id", "=", item.id)
				.where((eb) =>
					eb.not(
						eb.exists(
							eb
								.selectFrom("_emdash_menu_items")
								.select(sql`1`.as("one"))
								.whereRef("_emdash_menu_items.menu_id", "=", "_emdash_menus.id"),
						),
					),
				)
				.execute();
			return;
		case "widget_area":
			await db
				.deleteFrom("_emdash_widget_areas")
				.where("id", "=", item.id)
				.where((eb) =>
					eb.not(
						eb.exists(
							eb
								.selectFrom("_emdash_widgets")
								.select(sql`1`.as("one"))
								.whereRef("_emdash_widgets.area_id", "=", "_emdash_widget_areas.id"),
						),
					),
				)
				.execute();
			return;
		case "section":
			await db
				.deleteFrom("_emdash_sections")
				.where("id", "=", item.id)
				.where("source", "=", "theme")
				.execute();
			return;
		case "block_type":
			await db
				.deleteFrom("_emdash_block_type_versions")
				.where("block_type_id", "=", item.id)
				.where((eb) =>
					eb.exists(
						eb
							.selectFrom("_emdash_block_types")
							.select(sql`1`.as("one"))
							.where("_emdash_block_types.id", "=", item.id)
							.where("_emdash_block_types.source", "=", "seed"),
					),
				)
				.execute();
			await db
				.deleteFrom("_emdash_block_types")
				.where("id", "=", item.id)
				.where("source", "=", "seed")
				.execute();
			return;
		default:
			throw new TransferError("TRANSFER_IMPORT_ERROR", "Unknown scaffold item type", {
				detail: { type: item.type, id: item.id },
			});
	}
}
