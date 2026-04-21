/**
 * Contentful import execute endpoint
 *
 * POST /_emdash/api/import/contentful/execute
 *
 * Accepts a Contentful CDA response JSON file and imports content into the
 * database in dependency order: tags → authors/bylines → posts.
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
import { resolveImportByline, ensureUniqueBylineSlug } from "#import/utils.js";
import type { EmDashHandlers, EmDashManifest } from "#types";
import { slugify } from "#utils/slugify.js";

export const prerender = false;

export interface ContentfulImportConfig {
	/** Blog hostname for internal/external link detection */
	blogHostname?: string;
	/** Whether to skip items that already exist (matched by slug) */
	skipExisting?: boolean;
	/** BCP 47 locale for all imported items. Defaults to "en-us". */
	locale?: string;
}

export interface ContentfulImportResult {
	success: boolean;
	tags: { created: number; skipped: number; errors: string[] };
	authors: { created: number; updated: number; errors: string[] };
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

		const config: ContentfulImportConfig = configJson ? JSON.parse(configJson) : {};

		// Parse the Contentful export
		const text = await file.text();
		const raw = JSON.parse(text) as Record<string, unknown>;
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
	const locale = config.locale ?? "en-us";

	const result: ContentfulImportResult = {
		success: true,
		tags: { created: 0, skipped: 0, errors: [] },
		authors: { created: 0, updated: 0, errors: [] },
		bylines: { created: 0, skipped: 0, errors: [] },
		posts: { created: 0, updated: 0, skipped: 0, errors: [] },
		counts: Object.fromEntries([...parsed.byType.entries()].map(([k, v]) => [k, v.length])),
	};

	const taxonomyRepo = new TaxonomyRepository(emdash.db);
	const contentRepo = new ContentRepository(emdash.db);
	const bylineRepo = new BylineRepository(emdash.db);
	const bylineCache = new Map<string, string>();

	// ── Step 1: Tags ────────────────────────────────────────────────────

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

	// ── Step 2: Authors + Bylines ───────────────────────────────────────

	const authors = byType.get("blogAuthor") ?? [];
	const seenAuthorSlugs = new Set<string>();

	for (const entry of authors) {
		const author = mapAuthor(entry, includes);
		if (!author.slug) continue;

		// Skip duplicate author slugs in the export
		if (seenAuthorSlugs.has(author.slug)) continue;
		seenAuthorSlugs.add(author.slug);

		// Create or update the author collection entry
		if (manifest.collections["authors"]) {
			try {
				const existing = await contentRepo.findBySlug("authors", author.slug);
				if (existing) {
					result.authors.updated++;
				} else {
					await emdash.handleContentCreate("authors", {
						data: author.data as Record<string, unknown>,
						slug: author.slug,
						status: "published",
						locale,
					});
					result.authors.created++;
				}
			} catch (err) {
				result.authors.errors.push(`authors/${author.slug}: ${(err as Error).message}`);
			}
		}

		// Create byline for this author (if it doesn't exist)
		try {
			const existingByline = await bylineRepo.findBySlug(author.slug);
			if (existingByline) {
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

	// ── Step 3: Posts ────────────────────────────────────────────────────

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

		if (!mapped.slug) {
			mapped.slug = slugify(title);
		}

		try {
			// Idempotency: skip or update if slug already exists
			if (config.skipExisting) {
				const existing = await contentRepo.findBySlug("posts", mapped.slug, locale);
				if (existing) {
					result.posts.skipped++;
					continue;
				}
			}

			// Resolve byline IDs from author slugs
			const bylines = mapped.authorSlugs
				.map((slug) => {
					const bylineId = bylineCache.get(slug);
					return bylineId ? { bylineId } : null;
				})
				.filter((b): b is { bylineId: string } => b !== null);

			// Preserve original dates
			const createdAt = mapped.createdAt ?? undefined;
			const publishedAt = mapped.publishDate ?? createdAt;

			// Filter data to only include fields that exist in the collection schema.
			// handleContentCreate passes all data keys to SQL INSERT, so unknown
			// columns cause a SQLite error.
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
				locale,
				createdAt,
				publishedAt,
			});

			if (createResult.success) {
				result.posts.created++;

				// Set tag terms on the created post
				if (mapped.tagSlugs.length > 0) {
					const createdData = createResult.data as { id?: string } | undefined;
					if (createdData?.id) {
						const termIds: string[] = [];
						for (const tagSlug of mapped.tagSlugs) {
							const term = await taxonomyRepo.findBySlug("tag", tagSlug);
							if (term) termIds.push(term.id);
						}
						if (termIds.length > 0) {
							await taxonomyRepo.setTermsForEntry("posts", createdData.id, "tag", termIds);
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
