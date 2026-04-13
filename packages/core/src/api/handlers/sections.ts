/**
 * Section CRUD handlers
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { FindManyResult } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import {
	getSectionByIdWithDb,
	getSectionWithDb,
	getSectionsWithDb,
	type Section,
	type GetSectionsOptions,
} from "../../sections/index.js";
import type { ApiResult } from "../types.js";

const SLUG_PATTERN = /^[a-z0-9-]+$/;

export type SectionListResponse = FindManyResult<Section>;

/**
 * List sections with optional filters
 */
export async function handleSectionList(
	db: Kysely<Database>,
	params: GetSectionsOptions,
): Promise<ApiResult<SectionListResponse>> {
	try {
		const result = await getSectionsWithDb(db, {
			source: params.source,
			search: params.search,
			limit: params.limit,
			cursor: params.cursor,
		});

		return { success: true, data: result };
	} catch {
		return {
			success: false,
			error: { code: "SECTION_LIST_ERROR", message: "Failed to fetch sections" },
		};
	}
}

/**
 * Create a section
 */
export async function handleSectionCreate(
	db: Kysely<Database>,
	input: {
		slug: string;
		title: string;
		description?: string;
		keywords?: string[];
		content: unknown[];
		previewMediaId?: string;
		source?: string;
		themeId?: string;
	},
): Promise<ApiResult<Section>> {
	try {
		// Validate slug format
		if (!SLUG_PATTERN.test(input.slug)) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "slug must only contain lowercase letters, numbers, and hyphens",
				},
			};
		}

		// Check if slug already exists
		const existing = await db
			.selectFrom("_emdash_sections")
			.select("id")
			.where("slug", "=", input.slug)
			.executeTakeFirst();

		if (existing) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: `Section with slug "${input.slug}" already exists`,
				},
			};
		}

		const id = ulid();
		const now = new Date().toISOString();

		await db
			.insertInto("_emdash_sections")
			.values({
				id,
				slug: input.slug,
				title: input.title,
				description: input.description ?? null,
				keywords: input.keywords ? JSON.stringify(input.keywords) : null,
				content: JSON.stringify(input.content),
				preview_media_id: input.previewMediaId ?? null,
				source: input.source ?? "user",
				theme_id: input.themeId ?? null,
				created_at: now,
				updated_at: now,
			})
			.execute();

		const section = await getSectionByIdWithDb(id, db);
		if (!section) {
			return {
				success: false,
				error: { code: "SECTION_CREATE_ERROR", message: "Failed to fetch created section" },
			};
		}

		return { success: true, data: section };
	} catch {
		return {
			success: false,
			error: { code: "SECTION_CREATE_ERROR", message: "Failed to create section" },
		};
	}
}

/**
 * Get a section by slug
 */
export async function handleSectionGet(
	db: Kysely<Database>,
	slug: string,
): Promise<ApiResult<Section>> {
	try {
		const section = await getSectionWithDb(slug, db);

		if (!section) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Section "${slug}" not found` },
			};
		}

		return { success: true, data: section };
	} catch {
		return {
			success: false,
			error: { code: "SECTION_GET_ERROR", message: "Failed to fetch section" },
		};
	}
}

/**
 * Update a section by slug
 */
export async function handleSectionUpdate(
	db: Kysely<Database>,
	slug: string,
	input: {
		slug?: string;
		title?: string;
		description?: string;
		keywords?: string[];
		content?: unknown[];
		previewMediaId?: string | null;
	},
): Promise<ApiResult<Section>> {
	try {
		// Check if section exists
		const existing = await db
			.selectFrom("_emdash_sections")
			.select(["id", "source"])
			.where("slug", "=", slug)
			.executeTakeFirst();

		if (!existing) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Section "${slug}" not found` },
			};
		}

		// Validate new slug if changing
		if (input.slug && input.slug !== slug) {
			if (!SLUG_PATTERN.test(input.slug)) {
				return {
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						message: "slug must only contain lowercase letters, numbers, and hyphens",
					},
				};
			}

			// Check if new slug already exists
			const slugExists = await db
				.selectFrom("_emdash_sections")
				.select("id")
				.where("slug", "=", input.slug)
				.executeTakeFirst();

			if (slugExists) {
				return {
					success: false,
					error: {
						code: "CONFLICT",
						message: `Section with slug "${input.slug}" already exists`,
					},
				};
			}
		}

		// Build update object
		const updates: Record<string, unknown> = {
			updated_at: new Date().toISOString(),
		};

		if (input.slug !== undefined) updates.slug = input.slug;
		if (input.title !== undefined) updates.title = input.title;
		if (input.description !== undefined) updates.description = input.description;
		if (input.keywords !== undefined) updates.keywords = JSON.stringify(input.keywords);
		if (input.content !== undefined) updates.content = JSON.stringify(input.content);
		if (input.previewMediaId !== undefined) updates.preview_media_id = input.previewMediaId;

		await db.updateTable("_emdash_sections").set(updates).where("id", "=", existing.id).execute();

		const section = await getSectionByIdWithDb(existing.id, db);
		if (!section) {
			return {
				success: false,
				error: { code: "SECTION_UPDATE_ERROR", message: "Failed to fetch updated section" },
			};
		}

		return { success: true, data: section };
	} catch {
		return {
			success: false,
			error: { code: "SECTION_UPDATE_ERROR", message: "Failed to update section" },
		};
	}
}

/**
 * Delete a section by slug
 */
export async function handleSectionDelete(
	db: Kysely<Database>,
	slug: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		// Check if section exists and get source
		const existing = await db
			.selectFrom("_emdash_sections")
			.select(["id", "source", "theme_id"])
			.where("slug", "=", slug)
			.executeTakeFirst();

		if (!existing) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Section "${slug}" not found` },
			};
		}

		// Prevent deleting theme sections
		if (existing.source === "theme") {
			return {
				success: false,
				error: {
					code: "FORBIDDEN",
					message:
						"Cannot delete theme-provided sections. Edit the section to create a user copy, then delete that.",
				},
			};
		}

		await db.deleteFrom("_emdash_sections").where("id", "=", existing.id).execute();

		return { success: true, data: { deleted: true } };
	} catch {
		return {
			success: false,
			error: { code: "SECTION_DELETE_ERROR", message: "Failed to delete section" },
		};
	}
}
