import { sql, type Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import type { ApiResult } from "../types.js";

export type ActivityPeriod = "day" | "week" | "month";

export interface ActivityBucket {
	label: string;
	total: number;
	byCollection: Record<string, number>;
}

export interface ActivityData {
	period: ActivityPeriod;
	buckets: ActivityBucket[];
}

/** strftime format for each period granularity */
const PERIOD_FORMAT: Record<ActivityPeriod, string> = {
	day: "%Y-%m-%d",
	week: "%Y-%W",
	month: "%Y-%m",
};

export async function handleDashboardActivity(
	db: Kysely<Database>,
	period: ActivityPeriod,
	limit: number,
): Promise<ApiResult<ActivityData>> {
	try {
		const collections = await db
			.selectFrom("_emdash_collections")
			.select(["slug", "label"])
			.orderBy("slug", "asc")
			.execute();

		if (collections.length === 0) {
			return { success: true, data: { period, buckets: [] } };
		}

		const fmt = PERIOD_FORMAT[period];

		// Per-collection counts grouped by period bucket, fetched in parallel
		const perCollection = await Promise.all(
			collections.map(async (col) => {
				validateIdentifier(col.slug, "collection slug");
				const tableName = `ec_${col.slug}`;
				validateIdentifier(tableName, "table name");

				const rows = await sql<{ bucket: string; count: number }>`
					SELECT strftime(${fmt}, published_at) AS bucket, COUNT(*) AS count
					FROM ${sql.ref(tableName)}
					WHERE status = 'published'
					  AND deleted_at IS NULL
					  AND published_at IS NOT NULL
					GROUP BY bucket
					ORDER BY bucket DESC
					LIMIT ${limit}
				`.execute(db);

				return { slug: col.slug, rows: rows.rows };
			}),
		);

		// Collect every bucket label that appears across any collection
		const allLabels = new Set<string>();
		for (const { rows } of perCollection) {
			for (const row of rows) {
				if (row.bucket) allLabels.add(row.bucket);
			}
		}

		// Sort descending, take the most recent `limit` buckets
		const sortedLabels = [...allLabels].sort((a, b) => b.localeCompare(a)).slice(0, limit);

		// Build merged buckets
		const buckets: ActivityBucket[] = sortedLabels.map((label) => {
			const byCollection: Record<string, number> = {};
			let total = 0;
			for (const { slug, rows } of perCollection) {
				const row = rows.find((r) => r.bucket === label);
				const count = row ? Number(row.count) : 0;
				if (count > 0) byCollection[slug] = count;
				total += count;
			}
			return { label, total, byCollection };
		});

		// Return chronological order (oldest first) for chart rendering
		buckets.reverse();

		return { success: true, data: { period, buckets } };
	} catch (error) {
		console.error("Dashboard activity error:", error);
		return {
			success: false,
			error: {
				code: "DASHBOARD_ACTIVITY_ERROR",
				message: "Failed to load publishing activity",
			},
		};
	}
}
