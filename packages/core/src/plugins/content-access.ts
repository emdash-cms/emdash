import type { Kysely } from "kysely";

import { ContentRepository } from "../database/repositories/content.js";
import { SeoRepository } from "../database/repositories/seo.js";
import type { Database } from "../database/types.js";
import type { ContentAccess, ContentItem, ContentListOptions, PaginatedResult } from "./types.js";

export function createContentAccess(db: Kysely<Database>): ContentAccess {
	const contentRepo = new ContentRepository(db);
	const seoRepo = new SeoRepository(db);

	return {
		async get(collection: string, id: string): Promise<ContentItem | null> {
			const item = await contentRepo.findById(collection, id);
			if (!item) return null;

			const result: ContentItem = {
				id: item.id,
				type: item.type,
				slug: item.slug,
				status: item.status,
				data: item.data,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
				locale: item.locale,
				publishedAt: item.publishedAt,
				scheduledAt: item.scheduledAt,
			};

			if (await seoRepo.isEnabled(collection)) {
				result.seo = await seoRepo.get(collection, item.id);
			}

			return result;
		},

		async list(
			collection: string,
			options?: ContentListOptions,
		): Promise<PaginatedResult<ContentItem>> {
			let orderBy: { field: string; direction: "asc" | "desc" } | undefined;
			if (options?.orderBy) {
				const entries = Object.entries(options.orderBy);
				const first = entries[0];
				if (first) orderBy = { field: first[0], direction: first[1] };
			}

			const result = await contentRepo.findMany(collection, {
				limit: options?.limit ?? 50,
				cursor: options?.cursor,
				orderBy,
				where: options?.where,
			});

			const items: ContentItem[] = result.items.map((item) => ({
				id: item.id,
				type: item.type,
				slug: item.slug,
				status: item.status,
				data: item.data,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
				locale: item.locale,
				publishedAt: item.publishedAt,
				scheduledAt: item.scheduledAt,
			}));

			if (items.length > 0 && (await seoRepo.isEnabled(collection))) {
				const seoMap = await seoRepo.getMany(
					collection,
					items.map((item) => item.id),
				);
				for (const item of items) {
					const seo = seoMap.get(item.id);
					if (seo) item.seo = seo;
				}
			}

			return { items, cursor: result.nextCursor, hasMore: !!result.nextCursor };
		},
	};
}
