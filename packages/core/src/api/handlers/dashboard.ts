/**
 * Dashboard stats handler
 *
 * Returns summary data for the admin dashboard in a single request:
 * collection content counts, media count, user count, and recent
 * content across all collections.
 */

import { sql, type Kysely } from "kysely";

import { ContentRepository } from "../../database/repositories/content.js";
import { MediaRepository } from "../../database/repositories/media.js";
import { UserRepository } from "../../database/repositories/user.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import type { ApiResult } from "../types.js";

export interface CollectionStats {
	slug: string;
	label: string;
	total: number;
	published: number;
	draft: number;
}

export interface RecentItem {
	id: string;
	collection: string;
	collectionLabel: string;
	title: string;
	slug: string | null;
	status: string;
	updatedAt: string;
	authorId: string | null;
}

export interface DashboardStats {
	collections: CollectionStats[];
	mediaCount: number;
	userCount: number;
	recentItems: RecentItem[];
}

/**
 * Fetch dashboard statistics.
 *
 * Queries are intentionally lightweight — counts use indexed columns,
 * and recent items are capped at 10.
 */
export async function handleDashboardStats(
	db: Kysely<Database>,
): Promise<ApiResult<DashboardStats>> {
	try {
		// Discover collections from the system table
		const collections = await db
			.selectFrom("_emdash_collections")
			.select(["slug", "label"])
			.orderBy("slug", "asc")
			.execute();

		// Gather per-collection counts in parallel
		const contentRepo = new ContentRepository(db);
		const collectionStats: CollectionStats[] = await Promise.all(
			collections.map(async (col) => {
				const stats = await contentRepo.getStats(col.slug);
				return {
					slug: col.slug,
					label: col.label,
					total: stats.total,
					published: stats.published,
					draft: stats.draft,
				};
			}),
		);

		// Media and user counts
		const mediaRepo = new MediaRepository(db);
		const userRepo = new UserRepository(db);
		const [mediaCount, userCount] = await Promise.all([mediaRepo.count(), userRepo.count()]);

		// Recent items across all collections (last 10 updated, any status)
		const recentItems = await fetchRecentItems(db, collections);

		return {
			success: true,
			data: {
				collections: collectionStats,
				mediaCount,
				userCount,
				recentItems,
			},
		};
	} catch (error) {
		console.error("Dashboard stats error:", error);
		return {
			success: false,
			error: {
				code: "DASHBOARD_STATS_ERROR",
				message: "Failed to load dashboard statistics",
			},
		};
	}
}

/** Raw row shape from the UNION ALL query — all snake_case. */
interface RecentItemRow {
	id: string;
	collection: string;
	collection_label: string;
	title: string;
	slug: string | null;
	status: string;
	updated_at: string;
	author_id: string | null;
}

/**
 * Fetch the 10 most recently updated items across all collections.
 *
 * Queries each collection separately instead of building a single UNION ALL.
 * D1 has a low compound SELECT limit, and sites with many collections can
 * exceed it before SQLite does.
 *
 * `title` is not a standard column — it's a user-defined field. We query
 * `_emdash_fields` to discover which collections have one and fall back
 * to `slug` (which is always present) otherwise.
 */
async function fetchRecentItems(
	db: Kysely<Database>,
	collections: Array<{ slug: string; label: string }>,
): Promise<RecentItem[]> {
	if (collections.length === 0) return [];

	// Discover which collections have a "title" column
	const titleFields = await db
		.selectFrom("_emdash_fields as f")
		.innerJoin("_emdash_collections as c", "c.id", "f.collection_id")
		.select(["c.slug as collection_slug"])
		.where("f.slug", "=", "title")
		.execute();

	const collectionsWithTitle = new Set(titleFields.map((r) => r.collection_slug));

	const rowsByCollection = await Promise.all(
		collections.map(async (col) => {
			validateIdentifier(col.slug);
			const table = `ec_${col.slug}`;
			const hasTitle = collectionsWithTitle.has(col.slug);

			// Use title column if it exists, otherwise fall back to slug -> id.
			// All output uses snake_case to avoid SQLite quoting issues on D1.
			const titleExpr = hasTitle ? sql`COALESCE(title, slug, id)` : sql`COALESCE(slug, id)`;

			const result = await sql<RecentItemRow>`
				SELECT
					id,
					${col.slug} AS collection,
					${col.label} AS collection_label,
					${titleExpr} AS title,
					slug,
					status,
					updated_at,
					author_id
				FROM ${sql.ref(table)}
				WHERE deleted_at IS NULL
				ORDER BY updated_at DESC
				LIMIT 10
			`.execute(db);

			return result.rows;
		}),
	);

	const rows = rowsByCollection
		.flat()
		.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))
		.slice(0, 10);

	// Map snake_case DB rows -> camelCase API shape
	return rows.map((row) => ({
		id: row.id,
		collection: row.collection,
		collectionLabel: row.collection_label,
		title: row.title,
		slug: row.slug,
		status: row.status,
		updatedAt: row.updated_at,
		authorId: row.author_id,
	}));
}
