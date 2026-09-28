import type { Kysely } from "kysely";

import { ContentRepository } from "../database/repositories/content.js";
import { normalizeRevisionLimit, RevisionRepository } from "../database/repositories/revision.js";
import { SeoRepository } from "../database/repositories/seo.js";
import type { Database } from "../database/types.js";
import { resolveLocalizedContentRoutePath } from "../i18n/resolve.js";
import { SchemaRegistry } from "../schema/registry.js";
import type {
	ContentAccess,
	ContentItem,
	ContentListOptions,
	PaginatedResult,
	SiteInfo,
} from "./types.js";

export function createContentAccess(
	db: Kysely<Database>,
	accessOptions?: { site?: SiteInfo; revisions?: boolean },
): ContentAccess {
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
				authorId: item.authorId,
				translationGroup: item.translationGroup,
				liveRevisionId: item.liveRevisionId,
				draftRevisionId: item.draftRevisionId,
				version: item.version,
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
				authorId: item.authorId,
				translationGroup: item.translationGroup,
				liveRevisionId: item.liveRevisionId,
				draftRevisionId: item.draftRevisionId,
				version: item.version,
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

		async getTranslations(collection, id) {
			const item = await contentRepo.findById(collection, id);
			if (!item) throw new Error(`Content not found: ${collection}/${id}`);
			const translationGroup = item.translationGroup || item.id;
			const translations = item.translationGroup
				? await contentRepo.findTranslations(collection, item.translationGroup)
				: [item];
			return {
				translationGroup,
				translations: translations.map((translation) => ({
					id: translation.id,
					locale: translation.locale,
					slug: translation.slug,
					status: translation.status,
					updatedAt: translation.updatedAt,
				})),
			};
		},

		async getPublicUrl(collection, id) {
			const site = accessOptions?.site;
			if (!site?.url) return null;
			const [item, collectionInfo] = await Promise.all([
				contentRepo.findById(collection, id),
				new SchemaRegistry(db).getCollection(collection),
			]);
			if (!item || item.status !== "published" || !item.slug || !collectionInfo?.routable) {
				return null;
			}
			const path = await resolveLocalizedContentRoutePath({
				pattern: collectionInfo.urlPattern ?? null,
				collection,
				slug: item.slug,
				id: item.id,
				date: item.publishedAt,
				locale: item.locale || site.locale,
				trailingSlash: site.trailingSlash,
			});
			return path === null ? null : `${site.url}${path}`;
		},

		...(accessOptions?.revisions
			? {
					async listRevisions(
						collection: string,
						id: string,
						revisionOptions?: { limit?: number },
					) {
						const revisions = await new RevisionRepository(db).findVisibleByEntry(collection, id, {
							limit: normalizeRevisionLimit(revisionOptions?.limit),
						});
						return revisions.map(({ authorId: _authorId, ...revision }) => revision);
					},
					async getRevision(collection: string, id: string, revisionId: string) {
						const revision = await new RevisionRepository(db).findVisibleById(
							collection,
							id,
							revisionId,
						);
						if (!revision) return null;
						const { authorId: _authorId, ...safeRevision } = revision;
						return safeRevision;
					},
				}
			: {}),
	};
}
