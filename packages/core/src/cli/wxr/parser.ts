/**
 * WordPress WXR (WordPress eXtended RSS) parser
 *
 * Uses fast-xml-parser (pure ESM) to parse WXR export files.
 * Compatible with all JS runtimes including Cloudflare Workers (workerd),
 * where the previous sax dependency (CommonJS-only) caused "module is not defined" errors.
 *
 * WXR is an RSS extension containing WordPress content exports.
 *
 * @see https://developer.wordpress.org/plugins/data-storage/wp-xml-rpc/
 */

import type { Readable } from "node:stream";

import { XMLParser } from "fast-xml-parser";

// Regex patterns for WXR parsing
const PHP_SERIALIZED_STRING_PATTERN = /s:\d+:"([^"]+)"/g;
const PHP_SERIALIZED_STRING_MATCH_PATTERN = /s:\d+:"([^"]+)"/;

/**
 * Parsed WordPress export data
 */
export interface WxrData {
	/** Site metadata */
	site: WxrSite;
	/** Posts (including custom post types) */
	posts: WxrPost[];
	/** Media attachments */
	attachments: WxrAttachment[];
	/** Categories */
	categories: WxrCategory[];
	/** Tags */
	tags: WxrTag[];
	/** Authors */
	authors: WxrAuthor[];
	/** All taxonomy terms (including custom taxonomies and nav_menu) */
	terms: WxrTerm[];
	/** Parsed navigation menus */
	navMenus: WxrNavMenu[];
}

export interface WxrSite {
	title?: string;
	link?: string;
	description?: string;
	language?: string;
	baseSiteUrl?: string;
	baseBlogUrl?: string;
}

export interface WxrPost {
	id?: number;
	title?: string;
	link?: string;
	pubDate?: string;
	creator?: string;
	guid?: string;
	description?: string;
	content?: string;
	excerpt?: string;
	postDate?: string;
	postDateGmt?: string;
	postModified?: string;
	postModifiedGmt?: string;
	commentStatus?: string;
	pingStatus?: string;
	status?: string;
	postType?: string;
	postName?: string;
	postPassword?: string;
	isSticky?: boolean;
	/** Parent post ID for hierarchical content (pages) */
	postParent?: number;
	/** Menu order for sorting */
	menuOrder?: number;
	categories: string[];
	tags: string[];
	/** Custom taxonomy assignments beyond categories/tags */
	customTaxonomies?: Map<string, string[]>;
	meta: Map<string, string>;
}

export interface WxrAttachment {
	id?: number;
	title?: string;
	url?: string;
	postDate?: string;
	meta: Map<string, string>;
}

export interface WxrCategory {
	id?: number;
	nicename?: string;
	name?: string;
	parent?: string;
	description?: string;
}

export interface WxrTag {
	id?: number;
	slug?: string;
	name?: string;
	description?: string;
}

/**
 * Generic taxonomy term (categories, tags, nav_menu, custom taxonomies)
 */
export interface WxrTerm {
	id: number;
	taxonomy: string; // 'category', 'post_tag', 'nav_menu', 'genre', etc.
	slug: string;
	name: string;
	parent?: string;
	description?: string;
}

/**
 * Navigation menu structure
 */
export interface WxrNavMenu {
	id: number;
	name: string; // Menu slug
	label: string; // Menu name
	items: WxrNavMenuItem[];
}

/**
 * Navigation menu item
 */
export interface WxrNavMenuItem {
	id: number;
	menuId: number;
	parentId?: number;
	sortOrder: number;
	type: "custom" | "post_type" | "taxonomy";
	objectType?: string; // 'page', 'post', 'category'
	objectId?: number;
	url?: string;
	title: string;
	target?: string;
	classes?: string;
}

export interface WxrAuthor {
	id?: number;
	login?: string;
	email?: string;
	displayName?: string;
	firstName?: string;
	lastName?: string;
}

/**
 * Configure the XML parser for WXR format.
 *
 * Key options:
 * - preserveOrder: false → produces a clean JSON tree (not ordered event list)
 * - ignoreAttributes: false → we need attributes (e.g. category domain/nicename)
 * - parseTagValue: false → keep values as strings (WXR has dates, slugs, etc.)
 * - parseAttributeValue: false → keep attribute values as strings
 * - isArray: ensure elements that can appear multiple times are always arrays
 */
function createWxrParser(): XMLParser {
	return new XMLParser({
		preserveOrder: false,
		ignoreAttributes: false,
		parseTagValue: false,
		parseAttributeValue: false,
		removeNSPrefix: false,
		trimValues: false,
		isArray: (tagName) => {
			// Elements that can appear multiple times — always return as arrays
			switch (tagName.toLowerCase()) {
				case "item":
				case "wp:category":
				case "wp:tag":
				case "wp:author":
				case "wp:term":
				case "category":
				case "wp:postmeta":
					return true;
				default:
					return false;
			}
		},
	});
}

// ─── Helpers for the parsed XML tree ─────────────────────────────────
// Helpers accept `unknown` rather than a narrowed union because indexing
// `Record<string, unknown>` (what fast-xml-parser returns) yields
// `unknown`. All branches below are guarded at runtime, so permissive
// input types are safe.

/** Get text content from a parsed XML node (handles mixed text/element content) */
function getText(node: unknown): string {
	if (node === undefined || node === null) return "";
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	// fast-xml-parser may put text content in "#text" when attributes are present
	if (typeof node === "object") {
		const obj = node as Record<string, unknown>;
		if ("#text" in obj) return String(obj["#text"]);
		// If the node is an object without #text, it might be an empty element
		return "";
	}
	return String(node);
}

/** Get an attribute value from a parsed XML node */
function getAttr(node: unknown, attrName: string): string {
	if (typeof node !== "object" || node === null) return "";
	const obj = node as Record<string, unknown>;
	const key = `@_${attrName}`;
	if (key in obj) return String(obj[key]);
	return "";
}

/** Parse a numeric string, returning undefined for missing or invalid values. */
function parseIntSafe(val: string | undefined): number | undefined {
	if (!val) return undefined;
	const n = parseInt(val, 10);
	return isNaN(n) ? undefined : n;
}

/** Type guard for complete WxrTerm (all required fields present) */
function isCompleteWxrTerm(term: Partial<WxrTerm>): term is WxrTerm {
	return (
		term.id !== undefined &&
		term.taxonomy !== undefined &&
		term.slug !== undefined &&
		term.name !== undefined
	);
}

// ─── Core parsing logic ──────────────────────────────────────────────

/**
 * Parse WXR data from the fast-xml-parser JSON tree.
 *
 * This is the shared logic used by both the streaming and string-based
 * entry points.
 */
function extractWxrData(parsed: Record<string, unknown>): WxrData {
	const data: WxrData = {
		site: {},
		posts: [],
		attachments: [],
		categories: [],
		tags: [],
		authors: [],
		terms: [],
		navMenus: [],
	};

	// Track nav_menu_item posts for post-processing
	const navMenuItemPosts: WxrPost[] = [];
	// Track menu term IDs by slug for linking items to menus
	const menuTermsBySlug = new Map<string, number>();

	// Navigate to the RSS > channel node
	const rss = parsed["rss"] as Record<string, unknown> | undefined;
	if (!rss) return data;

	const channel = rss["channel"] as Record<string, unknown> | undefined;
	if (!channel) return data;

	// ── Site metadata from channel ─────────────────────────────────
	data.site.title = getText(channel["title"]) || undefined;
	data.site.link = getText(channel["link"]) || undefined;
	data.site.description = getText(channel["description"]) || undefined;
	data.site.language = getText(channel["language"]) || undefined;
	data.site.baseSiteUrl = getText(channel["wp:base_site_url"]) || undefined;
	data.site.baseBlogUrl = getText(channel["wp:base_blog_url"]) || undefined;

	// ── Categories (wp:category elements in channel) ───────────────
	const wxrCategories = channel["wp:category"] as Record<string, unknown>[] | undefined;
	if (wxrCategories) {
		for (const cat of wxrCategories) {
			const category: WxrCategory = {
				id: parseIntSafe(getText(cat["wp:term_id"])),
				nicename: getText(cat["wp:category_nicename"]) || undefined,
				name: getText(cat["wp:cat_name"]) || undefined,
				parent: getText(cat["wp:category_parent"]) || undefined,
				description: getText(cat["wp:category_description"]) || undefined,
			};
			if (category.name) {
				data.categories.push(category);
			}
		}
	}

	// ── Tags (wp:tag elements in channel) ──────────────────────────
	const wxrTags = channel["wp:tag"] as Record<string, unknown>[] | undefined;
	if (wxrTags) {
		for (const t of wxrTags) {
			const tag: WxrTag = {
				id: parseIntSafe(getText(t["wp:term_id"])),
				slug: getText(t["wp:tag_slug"]) || undefined,
				name: getText(t["wp:tag_name"]) || undefined,
				description: getText(t["wp:tag_description"]) || undefined,
			};
			if (tag.name) {
				data.tags.push(tag);
			}
		}
	}

	// ── Authors (wp:author elements in channel) ────────────────────
	const wxrAuthors = channel["wp:author"] as Record<string, unknown>[] | undefined;
	if (wxrAuthors) {
		for (const a of wxrAuthors) {
			const author: WxrAuthor = {
				id: parseIntSafe(getText(a["wp:author_id"])),
				login: getText(a["wp:author_login"]) || undefined,
				email: getText(a["wp:author_email"]) || undefined,
				displayName: getText(a["wp:author_display_name"]) || undefined,
				firstName: getText(a["wp:author_first_name"]) || undefined,
				lastName: getText(a["wp:author_last_name"]) || undefined,
			};
			if (author.login) {
				data.authors.push(author);
			}
		}
	}

	// ── Generic terms (wp:term elements in channel) ────────────────
	const wxrTerms = channel["wp:term"] as Record<string, unknown>[] | undefined;
	if (wxrTerms) {
		for (const t of wxrTerms) {
			const term: Partial<WxrTerm> = {
				id: parseIntSafe(getText(t["wp:term_id"])),
				taxonomy: getText(t["wp:term_taxonomy"]) || undefined,
				slug: getText(t["wp:term_slug"]) || undefined,
				name: getText(t["wp:term_name"]) || undefined,
				parent: getText(t["wp:term_parent"]) || undefined,
				description: getText(t["wp:term_description"]) || undefined,
			};
			if (isCompleteWxrTerm(term)) {
				data.terms.push(term);
				// Track nav_menu terms for building menus
				if (term.taxonomy === "nav_menu") {
					menuTermsBySlug.set(term.slug, term.id);
				}
			}
		}
	}

	// ── Items (posts, pages, attachments, nav_menu_items) ──────────
	const items = channel["item"] as Record<string, unknown>[] | undefined;
	if (items) {
		for (const item of items) {
			const post = parseWxrItem(item);
			if (!post) continue;

			if (post.postType === "attachment") {
				// Convert to attachment
				const attachment: WxrAttachment = {
					id: post.id,
					title: post.title,
					url: getText(item["wp:attachment_url"]) || post.link,
					postDate: post.postDate,
					meta: post.meta,
				};
				data.attachments.push(attachment);
			} else if (post.postType === "nav_menu_item") {
				navMenuItemPosts.push(post);
				data.posts.push(post);
			} else {
				data.posts.push(post);
			}
		}
	}

	// Post-process nav_menu_item posts into structured menus
	data.navMenus = buildNavMenus(navMenuItemPosts, menuTermsBySlug);

	return data;
}

/**
 * Parse a single <item> element into a WxrPost.
 */
function parseWxrItem(item: Record<string, unknown>): WxrPost | null {
	const post: WxrPost = {
		categories: [],
		tags: [],
		customTaxonomies: new Map(),
		meta: new Map(),
	};

	post.title = getText(item["title"]) || undefined;
	post.link = getText(item["link"]) || undefined;
	post.pubDate = getText(item["pubDate"]) || getText(item["pubdate"]) || undefined;
	post.creator = getText(item["dc:creator"]) || undefined;
	post.guid = getText(item["guid"]) || undefined;
	post.description = getText(item["description"]) || undefined;
	post.content = getText(item["content:encoded"]) || undefined;
	post.excerpt = getText(item["excerpt:encoded"]) || undefined;
	post.id = parseIntSafe(getText(item["wp:post_id"]));
	post.postDate = getText(item["wp:post_date"]) || undefined;
	post.postDateGmt = getText(item["wp:post_date_gmt"]) || undefined;
	post.postModified = getText(item["wp:post_modified"]) || undefined;
	post.postModifiedGmt = getText(item["wp:post_modified_gmt"]) || undefined;
	post.commentStatus = getText(item["wp:comment_status"]) || undefined;
	post.pingStatus = getText(item["wp:ping_status"]) || undefined;
	post.postName = getText(item["wp:post_name"]) || undefined;
	post.status = getText(item["wp:status"]) || undefined;
	post.postType = getText(item["wp:post_type"]) || undefined;
	post.postPassword = getText(item["wp:post_password"]) || undefined;
	post.isSticky = getText(item["wp:is_sticky"]) === "1";
	post.postParent = parseIntSafe(getText(item["wp:post_parent"]));
	post.menuOrder = parseIntSafe(getText(item["wp:menu_order"]));

	// ── Category/tag assignments (category elements in item) ───────
	const categoryNodes = item["category"] as Record<string, unknown>[] | undefined;
	if (categoryNodes) {
		for (const catNode of categoryNodes) {
			const domain = getAttr(catNode, "domain");
			const nicename = getAttr(catNode, "nicename");
			if (!nicename) continue;

			if (domain === "category") {
				post.categories.push(nicename);
			} else if (domain === "post_tag") {
				post.tags.push(nicename);
			} else if (domain && domain !== "category" && domain !== "post_tag") {
				// Custom taxonomy (including nav_menu)
				if (!post.customTaxonomies) {
					post.customTaxonomies = new Map();
				}
				const existing = post.customTaxonomies.get(domain) || [];
				existing.push(nicename);
				post.customTaxonomies.set(domain, existing);
			}
		}
	}

	// ── Post meta (wp:postmeta pairs) ──────────────────────────────
	const postmetaNodes = item["wp:postmeta"] as Record<string, unknown>[] | undefined;
	if (postmetaNodes) {
		for (const metaNode of postmetaNodes) {
			const key = getText(metaNode["wp:meta_key"]);
			const value = getText(metaNode["wp:meta_value"]);
			if (key) {
				post.meta.set(key, value);
			}
		}
	}

	return post;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Parse a WordPress WXR export from a string
 *
 * Compatible with all JS runtimes including Cloudflare Workers (workerd),
 * since fast-xml-parser is pure ESM with no Node.js-specific globals.
 */
export function parseWxrString(xml: string): Promise<WxrData> {
	try {
		const parser = createWxrParser();
		const parsed = parser.parse(xml) as Record<string, unknown>;
		return Promise.resolve(extractWxrData(parsed));
	} catch (err) {
		return Promise.reject(
			new Error(`XML parsing error: ${err instanceof Error ? err.message : String(err)}`),
		);
	}
}

/**
 * Parse a WordPress WXR export file from a Node.js Readable stream.
 *
 * Reads the entire stream into memory, then parses with fast-xml-parser.
 * Note: parseWxrString() also holds the full document in memory — reducing
 * peak memory for very large files (>100MB) would require a true streaming
 * parser, which is not currently implemented.
 */
export function parseWxr(stream: Readable): Promise<WxrData> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];

		stream.on("data", (chunk: Buffer | string) => {
			// Streams created with { encoding: "utf-8" } emit strings;
			// default (binary) streams emit Buffers. Normalize to Buffer
			// so Buffer.concat works regardless of caller configuration.
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk);
		});

		stream.on("error", (err) => {
			reject(new Error(`Failed to read WXR stream: ${err.message}`));
		});

		stream.on("end", () => {
			try {
				const xml = Buffer.concat(chunks).toString("utf-8");
				const parser = createWxrParser();
				const parsed = parser.parse(xml) as Record<string, unknown>;
				resolve(extractWxrData(parsed));
			} catch (err) {
				reject(new Error(`XML parsing error: ${err instanceof Error ? err.message : String(err)}`));
			}
		});
	});
}

/**
 * Build structured navigation menus from nav_menu_item posts
 */
function buildNavMenus(
	navMenuItemPosts: WxrPost[],
	menuTermsBySlug: Map<string, number>,
): WxrNavMenu[] {
	// Group menu items by menu slug
	const menuItemsByMenu = new Map<string, WxrPost[]>();

	for (const post of navMenuItemPosts) {
		// Get the nav_menu taxonomy assignment to find which menu this item belongs to
		const navMenuSlugs = post.customTaxonomies?.get("nav_menu");
		if (!navMenuSlugs || navMenuSlugs.length === 0) continue;

		const menuSlug = navMenuSlugs[0];
		if (!menuSlug) continue;

		const items = menuItemsByMenu.get(menuSlug) || [];
		items.push(post);
		menuItemsByMenu.set(menuSlug, items);
	}

	// Build structured menus
	const menus: WxrNavMenu[] = [];

	for (const [menuSlug, posts] of menuItemsByMenu) {
		const menuId = menuTermsBySlug.get(menuSlug) || 0;

		// Convert posts to menu items
		const items: WxrNavMenuItem[] = posts.map((post) => {
			const meta = post.meta;
			const menuItemTypeRaw = meta.get("_menu_item_type") || "custom";
			const menuItemType: WxrNavMenuItem["type"] =
				menuItemTypeRaw === "post_type" || menuItemTypeRaw === "taxonomy"
					? menuItemTypeRaw
					: "custom";
			const objectType = meta.get("_menu_item_object");
			const objectIdStr = meta.get("_menu_item_object_id");
			const url = meta.get("_menu_item_url");
			const parentIdStr = meta.get("_menu_item_menu_item_parent");
			const target = meta.get("_menu_item_target");
			const classesStr = meta.get("_menu_item_classes");

			// Parse classes (stored as serialized PHP array)
			let classes: string | undefined;
			if (classesStr) {
				// Simple extraction of class names from serialized PHP
				const matches = classesStr.match(PHP_SERIALIZED_STRING_PATTERN);
				if (matches) {
					classes = matches
						.map((m) => m.match(PHP_SERIALIZED_STRING_MATCH_PATTERN)?.[1])
						.filter(Boolean)
						.join(" ");
				}
			}

			return {
				id: post.id || 0,
				menuId,
				parentId: parentIdStr ? parseInt(parentIdStr, 10) || undefined : undefined,
				sortOrder: post.menuOrder || 0,
				type: menuItemType,
				objectType: objectType || undefined,
				objectId: objectIdStr ? parseInt(objectIdStr, 10) : undefined,
				url: url || undefined,
				title: post.title || "",
				target: target || undefined,
				classes: classes || undefined,
			};
		});

		// Sort items by menu_order
		items.sort((a, b) => a.sortOrder - b.sortOrder);

		// Find the menu name from the terms
		// For now, use the slug as both name and label; we could enhance this
		// by looking up the actual term name from data.terms
		menus.push({
			id: menuId,
			name: menuSlug,
			label: menuSlug, // Will be enhanced when we have term data
			items,
		});
	}

	return menus;
}
