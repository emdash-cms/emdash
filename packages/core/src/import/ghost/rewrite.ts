import type { GhostPost } from "./parser.js";

export interface GhostRewriteOptions {
	siteBaseUrl?: string;
	mediaBaseUrl?: string;
	postSlugs?: Set<string>;
	postRoutePrefix?: string;
	subscribePath?: string;
}

interface ResolvedGhostRewriteOptions {
	siteBaseUrl?: string;
	mediaBaseUrl?: string;
	postSlugs: Set<string>;
	postRoutePrefix: string;
	subscribePath: string;
}

const DEFAULT_POST_ROUTE_PREFIX = "/blog";
const DEFAULT_SUBSCRIBE_PATH = "/resources/#subscribe";
const GITHUB_TYPO_PATTERN = /https:\/\/githu\.com\/masonjames/gi;
const STYLE_TAG_PATTERN = /<style[^>]*>[\s\S]*?<\/style>/gi;
const SCRIPT_TAG_PATTERN = /<script[^>]*>[\s\S]*?<\/script>/gi;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const WHITESPACE_PATTERN = /\s+/g;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const GHOST_IMAGE_URL_PATTERN = /(?:__GHOST_URL__|https?:\/\/masonjames\.com)\/content\/images\//gi;
const GHOST_FILE_URL_PATTERN = /(?:__GHOST_URL__|https?:\/\/masonjames\.com)\/content\/files\//gi;
const RELATIVE_GHOST_IMAGE_PATH_PATTERN = /^\/content\/images\//i;
const RELATIVE_GHOST_FILE_PATH_PATTERN = /^\/content\/files\//i;
const HTML_ATTRIBUTE_URL_PATTERN = /\b(href|src)=["']([^"']+)["']/gi;
const POST_PATH_PATTERN = /^\/([a-z0-9-]+)\/?$/i;
const PORTAL_PATHS = new Set(["#/portal/signup", "#/portal/signin", "#/portal/"]);

function normalizeBaseUrl(value?: string): string | undefined {
	return value?.trim().replace(TRAILING_SLASHES_PATTERN, "") || undefined;
}

function buildMediaBase(normalizedMediaBase: string | undefined, kind: "images" | "files"): string {
	return normalizedMediaBase ? `${normalizedMediaBase}/content/${kind}/` : `/content/${kind}/`;
}

function resolveGhostPostSlug(url: string, siteBaseUrl?: string): string | undefined {
	const relativeMatch = url.match(POST_PATH_PATTERN);
	if (relativeMatch) {
		return relativeMatch[1];
	}

	if (!siteBaseUrl) {
		return undefined;
	}

	try {
		const absoluteUrl = new URL(url);
		const siteUrl = new URL(siteBaseUrl);
		if (absoluteUrl.origin !== siteUrl.origin) {
			return undefined;
		}
		return absoluteUrl.pathname.match(POST_PATH_PATTERN)?.[1];
	} catch {
		return undefined;
	}
}

function rewriteGhostAttributeUrl(url: string, options: ResolvedGhostRewriteOptions): string {
	if (PORTAL_PATHS.has(url)) {
		return options.subscribePath;
	}

	const normalizedUrl =
		normalizeGhostMediaUrl(url, options.mediaBaseUrl)?.replace(
			GITHUB_TYPO_PATTERN,
			"https://github.com/masonjames",
		) ?? url.replace(GITHUB_TYPO_PATTERN, "https://github.com/masonjames");
	const slug = resolveGhostPostSlug(normalizedUrl, options.siteBaseUrl);
	if (!slug || !options.postSlugs.has(slug)) {
		return normalizedUrl;
	}

	return `${options.postRoutePrefix}/${slug}/`;
}

export function stripGhostHtml(html: string): string {
	return String(html || "")
		.replace(HTML_TAG_PATTERN, " ")
		.replace(WHITESPACE_PATTERN, " ")
		.trim();
}

export function normalizeGhostMediaUrl(
	url: string | null | undefined,
	mediaBaseUrl?: string,
): string | undefined {
	const value = String(url || "").trim();
	if (!value) {
		return undefined;
	}

	const normalizedMediaBase = normalizeBaseUrl(mediaBaseUrl);
	const imageBase = buildMediaBase(normalizedMediaBase, "images");
	const fileBase = buildMediaBase(normalizedMediaBase, "files");

	if (RELATIVE_GHOST_IMAGE_PATH_PATTERN.test(value)) {
		return `${imageBase}${value.replace(RELATIVE_GHOST_IMAGE_PATH_PATTERN, "")}`;
	}

	if (RELATIVE_GHOST_FILE_PATH_PATTERN.test(value)) {
		return `${fileBase}${value.replace(RELATIVE_GHOST_FILE_PATH_PATTERN, "")}`;
	}

	return value
		.replace(GHOST_IMAGE_URL_PATTERN, imageBase)
		.replace(GHOST_FILE_URL_PATTERN, fileBase);
}

export function buildGhostExcerpt(post: Partial<GhostPost>, rewrittenHtml: string): string {
	const candidate =
		post.custom_excerpt ||
		post.excerpt ||
		post.plaintext ||
		stripGhostHtml(rewrittenHtml).slice(0, 200);
	const normalized = String(candidate || "")
		.replace(WHITESPACE_PATTERN, " ")
		.trim();

	return normalized || `Notes on: ${post.title || post.slug || "Untitled"}`;
}

export function rewriteGhostHtml(input: string, options: GhostRewriteOptions = {}): string {
	const resolvedOptions: ResolvedGhostRewriteOptions = {
		siteBaseUrl: normalizeBaseUrl(options.siteBaseUrl),
		mediaBaseUrl: options.mediaBaseUrl,
		postSlugs: options.postSlugs ?? new Set<string>(),
		postRoutePrefix: normalizeBaseUrl(options.postRoutePrefix) ?? DEFAULT_POST_ROUTE_PREFIX,
		subscribePath: options.subscribePath ?? DEFAULT_SUBSCRIBE_PATH,
	};

	return String(input || "")
		.replace(GITHUB_TYPO_PATTERN, "https://github.com/masonjames")
		.replace(STYLE_TAG_PATTERN, "")
		.replace(SCRIPT_TAG_PATTERN, "")
		.replace(HTML_ATTRIBUTE_URL_PATTERN, (fullMatch, attributeName: string, url: string) => {
			return `${attributeName}="${rewriteGhostAttributeUrl(url, resolvedOptions)}"`;
		});
}
