/**
 * Theme Marketplace API client
 *
 * Calls the site-side proxy endpoints (/_emdash/api/admin/themes/marketplace/*)
 * which forward to the marketplace Worker. The preview signing endpoint
 * is local (/_emdash/api/themes/preview).
 */

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

// ---------------------------------------------------------------------------
// Types — matches the marketplace REST API response shapes
// ---------------------------------------------------------------------------

export interface ThemeAuthor {
	name: string;
	verified: boolean;
	avatarUrl: string | null;
}

export interface ThemeAuthorDetail extends ThemeAuthor {
	id: string;
}

/** Summary shown in browse cards */
export interface ThemeSummary {
	id: string;
	name: string;
	description: string | null;
	author: ThemeAuthor;
	keywords: string[];
	previewUrl: string;
	demoUrl: string | null;
	hasThumbnail: boolean;
	thumbnailUrl: string | null;
	createdAt: string;
	updatedAt: string;
}

/** Full detail returned by GET /themes/:id */
export interface ThemeDetail extends Omit<ThemeSummary, "author"> {
	author: ThemeAuthorDetail;
	repositoryUrl: string | null;
	homepageUrl: string | null;
	license: string | null;
	screenshotCount: number;
	screenshotUrls: string[];
}

export interface ThemeSearchResult {
	items: ThemeSummary[];
	nextCursor?: string;
}

export interface ThemeSearchOpts {
	q?: string;
	keyword?: string;
	sort?: "name" | "created" | "updated";
	cursor?: string;
	limit?: number;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

const THEME_MARKETPLACE_BASE = `${API_BASE}/admin/themes/marketplace`;

/**
 * Search theme listings.
 * Proxied through /_emdash/api/admin/themes/marketplace
 */
export async function searchThemes(opts: ThemeSearchOpts = {}): Promise<ThemeSearchResult> {
	const params = new URLSearchParams();
	if (opts.q) params.set("q", opts.q);
	if (opts.keyword) params.set("keyword", opts.keyword);
	if (opts.sort) params.set("sort", opts.sort);
	if (opts.cursor) params.set("cursor", opts.cursor);
	if (opts.limit) params.set("limit", String(opts.limit));

	const qs = params.toString();
	const url = `${THEME_MARKETPLACE_BASE}${qs ? `?${qs}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<ThemeSearchResult>(response, "Theme search failed");
}

/**
 * Get full theme detail.
 * Proxied through /_emdash/api/admin/themes/marketplace/:id
 */
export async function fetchTheme(id: string): Promise<ThemeDetail> {
	const response = await apiFetch(`${THEME_MARKETPLACE_BASE}/${encodeURIComponent(id)}`);
	if (response.status === 404) {
		throw new Error(`Theme "${id}" not found`);
	}
	return parseApiResponse<ThemeDetail>(response, "Failed to fetch theme");
}

/**
 * Generate a signed preview URL for the "Try with my data" flow.
 * POST /_emdash/api/themes/preview (local, not proxied)
 */
export async function generatePreviewUrl(previewUrl: string): Promise<string> {
	const response = await apiFetch(`${API_BASE}/themes/preview`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ previewUrl }),
	});
	const result = await parseApiResponse<{ url: string }>(
		response,
		"Failed to generate preview URL",
	);
	return result.url;
}
