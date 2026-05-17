/**
 * WordPress WXR execute import endpoint
 *
 * POST /_emdash/api/import/wordpress/execute
 *
 * Accepts WXR file and import configuration, imports content into the database.
 */

import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";
import type { APIRoute } from "astro";
import {
	parseWxrString,
	ContentRepository,
	importReusableBlocksAsSections,
	type WxrPost,
	type WxrData,
	parseWxrDate,
} from "emdash";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import {
	handleMenuCreate,
	handleMenuDelete,
	handleMenuGet,
	handleMenuItemCreate,
} from "#api/handlers/menus.js";
import { BylineRepository } from "#db/repositories/byline.js";
import { resolveImportByline } from "#import/utils.js";
import { setSiteSettings } from "#settings/index.js";
import type { EmDashHandlers, EmDashManifest } from "#types";
import { slugify } from "#utils/slugify.js";

import { sanitizeSlug } from "./analyze.js";

const MENU_NAME_INVALID_CHARS = /[^a-z0-9_-]/g;
const MENU_NAME_REPEAT_DASHES = /-+/g;
const MENU_NAME_TRIM_DASHES = /^-|-$/g;

export const prerender = false;

export interface ImportConfig {
	postTypeMappings: Record<
		string,
		{
			collection: string;
			enabled: boolean;
		}
	>;
	skipExisting: boolean;
	importSections?: boolean;
	importMenus?: boolean;
	importSiteSettings?: boolean;
	authorMappings?: Record<string, string | null>;
	locale?: string;
}

export interface ImportResult {
	success: boolean;
	imported: number;
	skipped: number;
	errors: Array<{ title: string; error: string }>;
	byCollection: Record<string, number>;
	sections?: {
		created: number;
		skipped: number;
	};
	menus?: {
		created: number;
		items: number;
		replaced: number;
	};
	siteSettings?: {
		applied: string[];
	};
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	if (!emdash?.handleContentCreate) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	try {
		const emdashManifest = await emdash.getManifest();

		const formData = await request.formData();
		const fileEntry = formData.get("file");
		const file = fileEntry instanceof File ? fileEntry : null;
		const configEntry = formData.get("config");
		const configJson = typeof configEntry === "string" ? configEntry : null;

		if (!file) {
			return apiError("VALIDATION_ERROR", "No file provided", 400);
		}

		if (!configJson) {
			return apiError("VALIDATION_ERROR", "No config provided", 400);
		}

		const config: ImportConfig = JSON.parse(configJson);

		// Parse WXR
		const text = await file.text();
		const wxr = await parseWxrString(text);

		// Build attachment ID -> URL map for featured images
		const attachmentMap = new Map<string, string>();
		for (const att of wxr.attachments) {
			if (att.id && att.url) {
				attachmentMap.set(String(att.id), att.url);
			}
		}

		// Build author login -> display name map
		const authorDisplayNames = new Map<string, string>();
		for (const author of wxr.authors) {
			if (!author.login) continue;
			authorDisplayNames.set(author.login, author.displayName || author.login);
		}

		const internalHosts = collectInternalHosts(wxr);
		const { result, wpPostIdToImported } = await importContent(
			wxr.posts,
			config,
			emdash,
			emdashManifest,
			attachmentMap,
			config.locale,
			authorDisplayNames,
			internalHosts,
		);

		if (config.importSections !== false) {
			const sectionsResult = await importReusableBlocksAsSections(wxr.posts, emdash.db);
			result.sections = {
				created: sectionsResult.sectionsCreated,
				skipped: sectionsResult.sectionsSkipped,
			};
			result.errors.push(...sectionsResult.errors);
			if (sectionsResult.errors.length > 0) {
				result.success = false;
			}
		}

		if (config.importMenus !== false && wxr.navMenus.length > 0 && emdash.db) {
			try {
				result.menus = await importNavMenus(emdash.db, wxr, wpPostIdToImported);
			} catch (error) {
				result.errors.push({
					title: "Navigation menus",
					error: error instanceof Error ? error.message : "Failed to import menus",
				});
				result.success = false;
			}
		}

		if (config.importSiteSettings !== false && emdash.db) {
			try {
				const applied = await importSiteSettings(emdash.db, wxr);
				if (applied.length > 0) {
					result.siteSettings = { applied };
				}
			} catch (error) {
				result.errors.push({
					title: "Site settings",
					error: error instanceof Error ? error.message : "Failed to import site settings",
				});
				result.success = false;
			}
		}

		return apiSuccess(result);
	} catch (error) {
		return handleError(error, "Failed to import content", "WXR_IMPORT_ERROR");
	}
};

export interface ImportedRef {
	collection: string;
	contentId: string;
	slug: string;
	title?: string;
}

async function importContent(
	posts: WxrPost[],
	config: ImportConfig,
	emdash: EmDashHandlers,
	manifest: EmDashManifest,
	attachmentMap: Map<string, string>,
	locale?: string,
	authorDisplayNames?: Map<string, string>,
	internalHosts: Set<string> = new Set(),
): Promise<{ result: ImportResult; wpPostIdToImported: Map<number, ImportedRef> }> {
	const result: ImportResult = {
		success: true,
		imported: 0,
		skipped: 0,
		errors: [],
		byCollection: {},
	};
	const wpPostIdToImported = new Map<number, ImportedRef>();

	const contentRepo = new ContentRepository(emdash.db);
	const bylineRepo = new BylineRepository(emdash.db);
	const bylineCache = new Map<string, string>();

	for (const post of posts) {
		const postType = post.postType || "post";
		const mapping = config.postTypeMappings[postType];

		if (!mapping || !mapping.enabled) {
			result.skipped++;
			continue;
		}

		// mapping.collection is already sanitized by prepare, but the user can
		// edit the config between prepare and execute.
		const collection = sanitizeSlug(mapping.collection);

		if (!manifest?.collections[collection]) {
			result.errors.push({
				title: post.title || "Untitled",
				error: `Collection "${collection}" does not exist`,
			});
			continue;
		}

		try {
			const rawContent = post.content ? gutenbergToPortableText(post.content) : [];
			const content =
				internalHosts.size > 0 ? rewriteInternalLinks(rawContent, internalHosts) : rawContent;

			const slug = post.postName || slugify(post.title || `post-${post.id || Date.now()}`);

			if (config.skipExisting) {
				const existing = await contentRepo.findBySlug(collection, slug);
				if (existing) {
					// Record the mapping so menu import can still link to pages we skipped.
					if (post.id !== undefined) {
						wpPostIdToImported.set(post.id, {
							collection,
							contentId: existing.id,
							slug,
							title: post.title || undefined,
						});
					}
					result.skipped++;
					continue;
				}
			}

			// Map WordPress status to EmDash status
			const status = mapStatus(post.status);

			// Build data object with required fields
			const data: Record<string, unknown> = {
				title: post.title || "Untitled",
				content,
				excerpt: post.excerpt || undefined,
			};

			// Only add featured_image if the collection has this field and we have a value
			const collectionSchema = manifest.collections[collection];
			const hasFeaturedImageField = collectionSchema?.fields
				? "featured_image" in collectionSchema.fields
				: false;
			if (hasFeaturedImageField) {
				const thumbnailId = post.meta.get("_thumbnail_id");
				const featuredImage = thumbnailId ? attachmentMap.get(String(thumbnailId)) : undefined;
				if (featuredImage) {
					data.featured_image = featuredImage;
				}
			}

			let authorId: string | undefined;
			if (config.authorMappings && post.creator) {
				const mappedUserId = config.authorMappings[post.creator];
				if (mappedUserId !== undefined && mappedUserId !== null) {
					authorId = mappedUserId;
				}
			}

			const bylineId = await resolveImportByline(
				post.creator,
				authorDisplayNames?.get(post.creator ?? "") ?? post.creator,
				authorId,
				bylineRepo,
				bylineCache,
			);

			const parsedDate = parseWxrDate(post.postDateGmt, post.pubDate, post.postDate);
			const createdAt = parsedDate ? parsedDate.toISOString() : undefined;
			const publishedAt = status === "published" && createdAt ? createdAt : undefined;

			const createResult = await emdash.handleContentCreate(collection, {
				data,
				slug,
				status,
				authorId,
				bylines: bylineId ? [{ bylineId }] : undefined,
				locale,
				createdAt,
				publishedAt,
			});

			if (createResult.success) {
				result.imported++;
				result.byCollection[collection] = (result.byCollection[collection] || 0) + 1;
				if (post.id !== undefined && createResult.data?.item.id) {
					wpPostIdToImported.set(post.id, {
						collection,
						contentId: createResult.data.item.id,
						slug,
						title: post.title || undefined,
					});
				}
			} else {
				result.errors.push({
					title: post.title || "Untitled",
					error:
						typeof createResult.error === "object" && createResult.error !== null
							? (createResult.error as { message?: string }).message || "Unknown error"
							: String(createResult.error),
				});
			}
		} catch (error) {
			console.error(`Import error for "${post.title || "Untitled"}":`, error);
			result.errors.push({
				title: post.title || "Untitled",
				error: error instanceof Error && error.message ? error.message : "Failed to import item",
			});
		}
	}

	result.success = result.errors.length === 0;
	return { result, wpPostIdToImported };
}

export async function importNavMenus(
	db: NonNullable<EmDashHandlers["db"]>,
	wxr: WxrData,
	wpPostIdToImported: Map<number, ImportedRef>,
): Promise<{ created: number; items: number; replaced: number }> {
	let created = 0;
	let items = 0;
	let replaced = 0;

	const menuLabelBySlug = new Map<string, string>();
	for (const term of wxr.terms) {
		if (term.taxonomy === "nav_menu") {
			menuLabelBySlug.set(term.slug, term.name);
		}
	}

	for (const menu of wxr.navMenus) {
		const name = sanitizeMenuName(menu.name);
		if (!name) continue;

		const label = menuLabelBySlug.get(menu.name) || menu.label || menu.name;

		// Replace any same-named menu so re-imports stay idempotent.
		const existing = await handleMenuGet(db, name);
		if (existing.success) {
			await handleMenuDelete(db, name);
			replaced++;
		}

		const createResult = await handleMenuCreate(db, { name, label });
		if (!createResult.success) {
			throw new Error(`Failed to create menu "${name}": ${createResult.error.message}`);
		}
		created++;

		const wpIdToLocalItemId = new Map<number, string>();

		for (const item of menu.items) {
			const resolved = resolveMenuItemTarget(item, wpPostIdToImported);
			const parentLocalId = item.parentId
				? (wpIdToLocalItemId.get(item.parentId) ?? undefined)
				: undefined;

			const itemResult = await handleMenuItemCreate(db, name, {
				type: resolved.type,
				label: item.title || resolved.fallbackLabel,
				referenceCollection: resolved.referenceCollection,
				referenceId: resolved.referenceId,
				customUrl: resolved.customUrl,
				target: item.target || undefined,
				cssClasses: item.classes || undefined,
				parentId: parentLocalId,
				sortOrder: item.sortOrder,
			});

			if (itemResult.success) {
				items++;
				wpIdToLocalItemId.set(item.id, itemResult.data.id);
			}
		}
	}

	return { created, items, replaced };
}

interface ResolvedMenuTarget {
	type: "page" | "post" | "custom" | "taxonomy" | "collection";
	referenceCollection?: string;
	referenceId?: string;
	customUrl?: string;
	fallbackLabel: string;
}

function resolveMenuItemTarget(
	item: { type: string; objectType?: string; objectId?: number; url?: string; title: string },
	wpPostIdToImported: Map<number, ImportedRef>,
): ResolvedMenuTarget {
	if (item.type === "post_type" && item.objectId !== undefined) {
		const ref = wpPostIdToImported.get(item.objectId);
		if (ref) {
			const isPage = item.objectType === "page" || ref.collection === "pages";
			// WP stores an empty title when the item should render the linked page's
			// current title — prefer that over the raw slug.
			return {
				type: isPage ? "page" : "post",
				referenceCollection: ref.collection,
				referenceId: ref.contentId,
				fallbackLabel: ref.title || ref.slug,
			};
		}
	}

	// Fall back to a custom URL so the menu item isn't lost.
	return {
		type: "custom",
		customUrl: item.url || "#",
		fallbackLabel: item.title || "Menu item",
	};
}

function sanitizeMenuName(slug: string): string {
	return slug
		.toLowerCase()
		.replace(MENU_NAME_INVALID_CHARS, "-")
		.replace(MENU_NAME_REPEAT_DASHES, "-")
		.replace(MENU_NAME_TRIM_DASHES, "");
}

export async function importSiteSettings(
	db: NonNullable<EmDashHandlers["db"]>,
	wxr: WxrData,
): Promise<string[]> {
	const updates: Record<string, unknown> = {};
	const applied: string[] = [];

	if (wxr.site.title) {
		updates.title = wxr.site.title;
		applied.push("title");
	}
	if (wxr.site.description) {
		updates.tagline = wxr.site.description;
		applied.push("tagline");
	}
	const homeUrl = wxr.site.baseBlogUrl || wxr.site.link;
	if (homeUrl) {
		updates.url = homeUrl;
		applied.push("url");
	}

	if (applied.length === 0) return applied;

	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- SiteSettings subset
	await setSiteSettings(updates as { title?: string; tagline?: string; url?: string }, db);

	return applied;
}

export function collectInternalHosts(wxr: WxrData): Set<string> {
	const hosts = new Set<string>();
	const candidates = [wxr.site.link, wxr.site.baseBlogUrl, wxr.site.baseSiteUrl];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			hosts.add(new URL(candidate).host);
		} catch {
			// Not a valid URL.
		}
	}
	return hosts;
}

export function rewriteInternalLinks<T>(blocks: T, internalHosts: Set<string>): T {
	if (internalHosts.size === 0) return blocks;

	const rewriteUrl = (url: string): string => {
		try {
			const parsed = new URL(url);
			if (!internalHosts.has(parsed.host)) return url;
			const path = parsed.pathname || "/";
			return `${path}${parsed.search}${parsed.hash}`;
		} catch {
			return url;
		}
	};

	const visit = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map((v) => visit(v));
		if (!value || typeof value !== "object") return value;

		const obj = value as Record<string, unknown>;
		const type = typeof obj._type === "string" ? obj._type : undefined;

		if (type === "button" && typeof obj.url === "string") {
			return { ...obj, url: rewriteUrl(obj.url) };
		}
		if (type === "link" && typeof obj.href === "string") {
			return { ...obj, href: rewriteUrl(obj.href) };
		}

		// Recurse into children but leave scalar fields on other nodes alone —
		// image / gallery URLs must stay absolute for the media-URL rewrite step.
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(obj)) {
			out[key] = visit(child);
		}
		return out;
	};

	return visit(blocks) as T;
}

function mapStatus(wpStatus: string | undefined): string {
	switch (wpStatus) {
		case "publish":
			return "published";
		case "draft":
			return "draft";
		case "pending":
			return "draft";
		case "private":
			return "draft";
		default:
			return "draft";
	}
}
