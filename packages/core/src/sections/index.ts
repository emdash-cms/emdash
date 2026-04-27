/**
 * Sections runtime functions
 *
 * Sections are reusable content blocks that can be inserted into any Portable Text field.
 */

import type { Kysely } from "kysely";

import { encodeCursor, decodeCursor, type FindManyResult } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import type { Section, SectionRow, GetSectionsOptions } from "./types.js";

export type {
	Section,
	SectionSource,
	SectionRow,
	CreateSectionInput,
	UpdateSectionInput,
	GetSectionsOptions,
} from "./types.js";

/**
 * Get a section by slug
 *
 * @example
 * ```ts
 * import { getSection } from "emdash";
 *
 * const section = await getSection("hero-centered");
 * if (section) {
 *   console.log(section.content); // Portable Text array
 * }
 * ```
 */
export async function getSection(slug: string): Promise<Section | null> {
	const db = await getDb();
	return getSectionWithDb(slug, db);
}

/**
 * Get a section by slug (with explicit db)
 *
 * @internal Use `getSection()` in templates. This variant is for admin routes
 * that already have a database handle.
 */
export async function getSectionWithDb(
	slug: string,
	db: Kysely<Database>,
): Promise<Section | null> {
	const row = await db
		.selectFrom("_emdash_sections")
		.selectAll()
		.$castTo<SectionRow>()
		.where("slug", "=", slug)
		.executeTakeFirst();

	if (!row) {
		return null;
	}

	return rowToSection(row, db);
}

/**
 * Get a section by ID
 *
 * @internal Primarily for admin use
 */
export async function getSectionById(id: string, db: Kysely<Database>): Promise<Section | null> {
	const row = await db
		.selectFrom("_emdash_sections")
		.selectAll()
		.$castTo<SectionRow>()
		.where("id", "=", id)
		.executeTakeFirst();

	if (!row) {
		return null;
	}

	return rowToSection(row, db);
}

/**
 * Get all sections with optional filtering
 *
 * @example
 * ```ts
 * import { getSections } from "emdash";
 *
 * // Get all theme-provided sections
 * const themeSections = await getSections({ source: "theme" });
 *
 * // Search sections
 * const results = await getSections({ search: "pricing" });
 * ```
 */
export async function getSections(
	options: GetSectionsOptions = {},
): Promise<FindManyResult<Section>> {
	const db = await getDb();
	return getSectionsWithDb(db, options);
}

/**
 * Get all sections with optional filtering (with explicit db)
 *
 * @internal Use `getSections()` in templates. This variant is for admin routes
 * that already have a database handle.
 */
export async function getSectionsWithDb(
	db: Kysely<Database>,
	options: GetSectionsOptions = {},
): Promise<FindManyResult<Section>> {
	const limit = Math.min(Math.max(1, options.limit || 50), 100);

	let query = db.selectFrom("_emdash_sections").selectAll();

	// Filter by source
	if (options.source) {
		query = query.where("source", "=", options.source);
	}

	// Search - search title, description, and keywords
	if (options.search) {
		const searchTerm = `%${options.search.toLowerCase()}%`;
		query = query.where((eb) =>
			eb.or([
				eb("title", "like", searchTerm),
				eb("description", "like", searchTerm),
				eb("keywords", "like", searchTerm),
			]),
		);
	}

	// Order by title ASC, id ASC for stable cursor pagination
	query = query.orderBy("title", "asc").orderBy("id", "asc");

	// Cursor-based pagination — throws on invalid cursor.
	if (options.cursor) {
		const decoded = decodeCursor(options.cursor);
		query = query.where((eb) =>
			eb.or([
				eb("title", ">", decoded.orderValue),
				eb.and([eb("title", "=", decoded.orderValue), eb("id", ">", decoded.id)]),
			]),
		);
	}

	query = query.limit(limit + 1);

	const rows = await query.$castTo<SectionRow>().execute();
	const hasMore = rows.length > limit;
	const sliced = rows.slice(0, limit);

	// Convert rows to sections
	const items = await Promise.all(sliced.map((row) => rowToSection(row, db)));
	const result: FindManyResult<Section> = { items };

	if (hasMore && items.length > 0) {
		const last = items.at(-1)!;
		result.nextCursor = encodeCursor(last.title, last.id);
	}

	return result;
}

/**
 * Convert a section row to the API type
 */
async function rowToSection(row: SectionRow, db: Kysely<Database>): Promise<Section> {
	// Parse keywords
	let keywords: string[] = [];
	if (row.keywords) {
		try {
			keywords = JSON.parse(row.keywords);
		} catch {
			// Invalid JSON, ignore
		}
	}

	// Parse content — stored as JSON array of Portable Text blocks
	let content: Section["content"] = [];
	if (row.content) {
		try {
			const parsed: unknown = JSON.parse(row.content);
			if (Array.isArray(parsed)) {
				// DB stores serialized PortableTextBlock[]; trust the schema
				content = parsed;
			}
		} catch {
			// Invalid JSON, ignore
		}
	}

	// Get preview URL from media (if present)
	let previewUrl: string | undefined;
	if (row.preview_media_id) {
		const media = await db
			.selectFrom("media")
			.select("storage_key")
			.where("id", "=", row.preview_media_id)
			.executeTakeFirst();

		if (media) {
			previewUrl = `/_emdash/media/${media.storage_key}`;
		}
	}

	return {
		id: row.id,
		slug: row.slug,
		title: row.title,
		description: row.description ?? undefined,
		keywords,
		content,
		previewUrl,
		source: row.source,
		themeId: row.theme_id ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
