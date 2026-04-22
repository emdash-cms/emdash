/**
 * Contentful import execute endpoint
 *
 * POST /_emdash/api/import/contentful/execute
 *
 * Accepts a Contentful CDA response JSON file and imports content into the
 * database in dependency order: tags -> authors/bylines -> posts.
 *
 * Uses handleContentCreate for posts to preserve createdAt/publishedAt dates.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { BylineRepository } from "#db/repositories/byline.js";
import { ContentRepository } from "#db/repositories/content.js";
import { TaxonomyRepository } from "#db/repositories/taxonomy.js";
import { parseContentfulExport, mapTag, mapAuthor, mapPost } from "#import/contentful/index.js";
import { ensureUniqueBylineSlug } from "#import/utils.js";
import type { EmDashHandlers, EmDashManifest } from "#types";
import { slugify } from "#utils/slugify.js";

export const prerender = false;

export interface ContentfulImportConfig {
	/** Blog hostname for internal/external link detection */
	blogHostname?: string;
	/** Whether to skip posts that already exist (matched by slug + locale) */
	skipExisting?: boolean;
	/** BCP 47 locale override for all imported items. Defaults to the site default locale or "en". */
	locale?: string;
}

export interface ContentfulImportResult {
	success: boolean;
	tags: { created: number; skipped: number; errors: string[] };
	authors: { created: number; skipped: number; updated: number; errors: string[] };
	bylines: { created: number; skipped: number; errors: string[] };
	posts: {
		created: number;
		updated: number;
		skipped: number;
		errors: Array<{ title: string; error: string }>;
	};
	counts: Record<string, number>;
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, emdashManifest, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	if (!emdash?.handleContentCreate) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	try {
		const formData = await request.formData();
		const fileEntry = formData.get("file");
		const file = fileEntry instanceof File ? fileEntry : null;
		const configEntry = formData.get("config");
		const configJson = typeof configEntry === "string" ? configEntry : null;

		if (!file) {
			return apiError("VALIDATION_ERROR", "No file provided", 400);
		}

		let config: ContentfulImportConfig = {};
		if (configJson) {
			try {
				config = JSON.parse(configJson) as ContentfulImportConfig;
			} catch {
				return apiError("VALIDATION_ERROR", "Invalid import config JSON", 400);
			}
		}

		// Parse the Contentful export
		const text = await file.text();
		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse(text) as Record<string, unknown>;
		} catch {
			return apiError("VALIDATION_ERROR", "Invalid Contentful export JSON", 400);
		}
		const parsed = parseContentfulExport(raw);

		const result = await executeContentfulImport(parsed, config, emdash, emdashManifest);

		return apiSuccess(result);
	} catch (error) {
		return handleError(error, "Failed to import Contentful content", "CONTENTFUL_IMPORT_ERROR");
	}
};

async function executeContentfulImport(
	parsed: ReturnType<typeof parseContentfulExport>,
	config: ContentfulImportConfig,
	emdash: EmDashHandlers,
	manifest: EmDashManifest,
): Promise<ContentfulImportResult> {
	const { byType, includes } = parsed;
	const locale = config.locale ?? manifest.i18n?.defaultLocale ?? "en";

	const result: ContentfulImportResult = {
		success: true,
		tags: { created: 0, skipped: 0, errors: [] },
		authors: { created: 0, skipped: 0, updated: 0, errors: [] },
		bylines: { created: 0, skipped: 0, errors: [] },
		posts: { created: 0, updated: 0, skipped: 0, errors: [] },
		counts: Object.fromEntries([...parsed.byType.entries()].map(([k, v]) => [k, v.length])),
	};

	const taxonomyRepo = new TaxonomyRepository(emdash.db);
	const contentRepo = new ContentRepository(emdash.db);
	const bylineRepo = new BylineRepository(emdash.db);
	const bylineCache = new Map<string, string>();
	const authorsCollection = manifest.collections["authors"];
	const bylineSyncLocale = config.locale ?? manifest.i18n?.defaultLocale ?? "en";

	// Step 1: Tags
	const tags = byType.get("blogTag") ?? [];
	for (const entry of tags) {
		const term = mapTag(entry);
		if (!term.slug || !term.label) continue;

		try {
			const existing = await taxonomyRepo.findBySlug("tag", term.slug);
			if (existing) {
				result.tags.skipped++;
				continue;
			}

			await taxonomyRepo.create({
				name: "tag",
				slug: term.slug,
				label: term.label,
			});
			result.tags.created++;
		} catch (err) {
			result.tags.errors.push(`tag/${term.slug}: ${(err as Error).message}`);
		}
	}

	// Step 2: Authors + Bylines
	const authors = byType.get("blogAuthor") ?? [];
	const seenAuthorSlugs = new Set<string>();

	for (const entry of authors) {
		const author = mapAuthor(entry, includes);
		if (!author.slug) continue;
		const authorLocale = config.locale ?? author.locale ?? locale;
		const authorKey = `${authorLocale}:${author.slug}`;

		if (seenAuthorSlugs.has(authorKey)) {
			result.authors.skipped++;
			continue;
		}
		seenAuthorSlugs.add(authorKey);

		if (authorsCollection) {
			try {
				const filteredAuthorData = filterDataForCollection(
					author.data as Record<string, unknown>,
					authorsCollection,
				);
				const existing = await contentRepo.findBySlug("authors", author.slug, authorLocale);
				if (existing) {
					const updateResult = await emdash.handleContentUpdate("authors", existing.id, {
						data: filteredAuthorData,
						slug: author.slug,
						status: "published",
					});
					if (!updateResult.success) {
						result.authors.errors.push(
							`authors/${author.slug}: ${formatHandlerError(updateResult.error)}`,
						);
					} else {
						result.authors.updated++;
					}
				} else {
					const createResult = await emdash.handleContentCreate("authors", {
						data: filteredAuthorData,
						slug: author.slug,
						status: "published",
						locale: authorLocale,
					});
					if (!createResult.success) {
						result.authors.errors.push(
							`authors/${author.slug}: ${formatHandlerError(createResult.error)}`,
						);
					} else {
						result.authors.created++;
					}
				}
			} catch (err) {
				result.authors.errors.push(`authors/${author.slug}: ${(err as Error).message}`);
			}
		}

		try {
			const existingByline = await bylineRepo.findBySlug(author.slug);
			if (existingByline) {
				if (authorLocale === bylineSyncLocale && existingByline.displayName !== author.data.name) {
					await bylineRepo.update(existingByline.id, {
						displayName: author.data.name,
					});
				}
				bylineCache.set(author.slug, existingByline.id);
				result.bylines.skipped++;
			} else {
				const slug = await ensureUniqueBylineSlug(bylineRepo, author.slug);
				const created = await bylineRepo.create({
					slug,
					displayName: author.data.name,
					userId: null,
					isGuest: true,
				});
				bylineCache.set(author.slug, created.id);
				result.bylines.created++;
			}
		} catch (err) {
			result.bylines.errors.push(`byline/${author.slug}: ${(err as Error).message}`);
		}
	}

	// Step 3: Posts
	const posts = byType.get("blogPost") ?? [];
	const postsCollection = manifest.collections["posts"];
	if (!postsCollection) {
		result.posts.errors.push({
			title: "(all)",
			error: 'Collection "posts" does not exist',
		});
		result.success = false;
		return result;
	}

	for (const entry of posts) {
		const mapped = mapPost(entry, includes, {
			blogHostname: config.blogHostname,
		});
		const title = (mapped.data.title as string) || "Untitled";
		const postLocale = config.locale ?? mapped.locale ?? locale;

		if (!mapped.slug) {
			mapped.slug = slugify(title);
		}

		try {
			if (config.skipExisting) {
				const existing = await contentRepo.findBySlug("posts", mapped.slug, postLocale);
				if (existing) {
					result.posts.skipped++;
					continue;
				}
			}

			const bylines = mapped.authorSlugs
				.map((slug) => {
					const bylineId = bylineCache.get(slug);
					return bylineId ? { bylineId } : null;
				})
				.filter((b): b is { bylineId: string } => b !== null);

			const createdAt = mapped.createdAt ?? undefined;
			const publishedAt = mapped.publishDate ?? createdAt;

			const collectionFields = postsCollection.fields
				? new Set(Object.keys(postsCollection.fields))
				: null;
			const filteredData: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(mapped.data)) {
				if (value === undefined) continue;
				if (collectionFields && !collectionFields.has(key)) continue;
				filteredData[key] = value;
			}

			const createResult = await emdash.handleContentCreate("posts", {
				data: filteredData,
				slug: mapped.slug,
				status: "published",
				bylines: bylines.length > 0 ? bylines : undefined,
				locale: postLocale,
				createdAt,
				publishedAt,
				seo: postsCollection.hasSeo ? mapped.seo : undefined,
			});

			if (createResult.success) {
				result.posts.created++;

				if (mapped.tagSlugs.length > 0) {
					const responseData = createResult.data as
						| { item?: { id?: string } }
						| undefined;
					const postId = responseData?.item?.id;
					if (postId) {
						const termIds: string[] = [];
						for (const tagSlug of mapped.tagSlugs) {
							const term = await taxonomyRepo.findBySlug("tag", tagSlug);
							if (term) termIds.push(term.id);
						}
						if (termIds.length > 0) {
							await taxonomyRepo.setTermsForEntry("posts", postId, "tag", termIds);
						}
					}
				}
			} else {
				const err = createResult.error as { code?: string; message?: string } | string | undefined;
				const errorMsg =
					typeof err === "object" && err !== null
						? `${err.code ?? "UNKNOWN"}: ${err.message ?? "Unknown error"}`
						: String(err ?? "Unknown error");
				console.error(
					`[contentful-import] Post "${title}" failed:`,
					JSON.stringify(createResult.error),
				);
				result.posts.errors.push({ title, error: errorMsg });
			}
		} catch (err) {
			result.posts.errors.push({
				title,
				error: err instanceof Error ? err.message : "Failed to import",
			});
		}
	}

	result.success =
		result.tags.errors.length === 0 &&
		result.authors.errors.length === 0 &&
		result.bylines.errors.length === 0 &&
		result.posts.errors.length === 0;

	return result;
}

function filterDataForCollection(
	data: Record<string, unknown>,
	collection: EmDashManifest["collections"][string],
): Record<string, unknown> {
	const collectionFields = collection.fields ? new Set(Object.keys(collection.fields)) : null;
	const filteredData: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		if (collectionFields && !collectionFields.has(key)) continue;
		filteredData[key] = value;
	}
	return filteredData;
}

function formatHandlerError(
	error: { code?: string; message?: string } | string | undefined,
): string {
	return typeof error === "object" && error !== null
		? `${error.code ?? "UNKNOWN"}: ${error.message ?? "Unknown error"}`
		: String(error ?? "Unknown error");
}
