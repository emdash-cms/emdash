/**
 * Marketplace API client
 *
 * Calls the site-side proxy endpoints (/_emdash/api/admin/plugins/marketplace/*)
 * which forward to the marketplace Worker. This avoids CORS issues since the
 * admin UI doesn't need to know the marketplace URL.
 */

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

// ---------------------------------------------------------------------------
// Types — matches the marketplace REST API response shapes
// ---------------------------------------------------------------------------

export interface MarketplaceAuthor {
	name: string;
	verified: boolean;
}

export interface MarketplaceAuditSummary {
	verdict: "pass" | "warn" | "fail";
	riskScore: number;
}

export interface MarketplaceImageAuditSummary {
	verdict: "pass" | "warn" | "fail";
}

export interface MarketplaceVersion {
	version: string;
	minEmDashVersion?: string;
	bundleSize: number;
	changelog?: string;
	readme?: string;
	screenshotUrls?: string[];
	audit?: MarketplaceAuditSummary;
	imageAudit?: MarketplaceImageAuditSummary;
	publishedAt: string;
}

/** Summary shown in browse cards */
export interface MarketplacePluginSummary {
	id: string;
	name: string;
	description?: string;
	author: MarketplaceAuthor;
	capabilities: string[];
	keywords?: string[];
	installCount: number;
	iconUrl?: string;
	latestVersion?: {
		version: string;
		audit?: MarketplaceAuditSummary;
		imageAudit?: MarketplaceImageAuditSummary;
	};
	createdAt: string;
	updatedAt: string;
}

/** Full detail returned by GET /plugins/:id */
export interface MarketplacePluginDetail extends MarketplacePluginSummary {
	license?: string;
	repositoryUrl?: string;
	homepageUrl?: string;
	latestVersion?: MarketplaceVersion;
}

export interface MarketplaceSearchResult {
	items: MarketplacePluginSummary[];
	nextCursor?: string;
}

export interface MarketplaceSearchOpts {
	q?: string;
	capability?: string;
	category?: string;
	sort?: "installs" | "updated" | "created" | "name";
	cursor?: string;
	limit?: number;
}

export interface MarketplaceCategory {
	id: string;
	slug: string;
	name: string;
	description?: string;
	icon?: string;
}

/** Update check result per plugin */
export interface PluginUpdateInfo {
	pluginId: string;
	installed: string;
	latest: string;
	hasCapabilityChanges: boolean;
}

/** Install request body */
export interface InstallPluginOpts {
	version?: string;
}

/** Update request body */
export interface UpdatePluginOpts {
	/** User has confirmed new capabilities */
	confirmCapabilities?: boolean;
}

/** Uninstall request body */
export interface UninstallPluginOpts {
	/** Delete plugin storage data */
	deleteData?: boolean;
}

// ---------------------------------------------------------------------------
// API functions — proxy through site endpoints
// ---------------------------------------------------------------------------

const MARKETPLACE_BASE = `${API_BASE}/admin/plugins/marketplace`;

/**
 * Search the marketplace catalog.
 * Proxied through /_emdash/api/admin/plugins/marketplace
 */
export async function searchMarketplace(
	opts: MarketplaceSearchOpts = {},
): Promise<MarketplaceSearchResult> {
	const params = new URLSearchParams();
	if (opts.q) params.set("q", opts.q);
	if (opts.capability) params.set("capability", opts.capability);
	if (opts.category) params.set("category", opts.category);
	if (opts.sort) params.set("sort", opts.sort);
	if (opts.cursor) params.set("cursor", opts.cursor);
	if (opts.limit) params.set("limit", String(opts.limit));

	const qs = params.toString();
	const url = `${MARKETPLACE_BASE}${qs ? `?${qs}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<MarketplaceSearchResult>(response, "Marketplace search failed");
}

/**
 * Fetch available marketplace categories.
 * Proxied through /_emdash/api/admin/plugins/marketplace/categories
 */
export async function fetchCategories(): Promise<MarketplaceCategory[]> {
	const response = await apiFetch(`${MARKETPLACE_BASE}/categories`);
	const data = await parseApiResponse<{ items: MarketplaceCategory[] }>(
		response,
		"Failed to fetch categories",
	);
	return data.items;
}

/**
 * Get full plugin detail.
 * Proxied through /_emdash/api/admin/plugins/marketplace/:id
 */
export async function fetchMarketplacePlugin(id: string): Promise<MarketplacePluginDetail> {
	const response = await apiFetch(`${MARKETPLACE_BASE}/${encodeURIComponent(id)}`);
	if (response.status === 404) {
		throw new Error(`Plugin "${id}" not found in marketplace`);
	}
	return parseApiResponse<MarketplacePluginDetail>(response, "Failed to fetch plugin");
}

/**
 * Install a plugin from the marketplace.
 * POST /_emdash/api/admin/plugins/marketplace/:id/install
 */
export async function installMarketplacePlugin(
	id: string,
	opts: InstallPluginOpts = {},
): Promise<void> {
	const response = await apiFetch(`${MARKETPLACE_BASE}/${encodeURIComponent(id)}/install`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(opts),
	});
	if (!response.ok) await throwResponseError(response, "Failed to install plugin");
}

/**
 * Update a marketplace plugin to a newer version.
 * POST /_emdash/api/admin/plugins/:id/update
 */
export async function updateMarketplacePlugin(
	id: string,
	opts: UpdatePluginOpts = {},
): Promise<void> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/${encodeURIComponent(id)}/update`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(opts),
	});
	if (!response.ok) await throwResponseError(response, "Failed to update plugin");
}

/**
 * Uninstall a marketplace plugin.
 * POST /_emdash/api/admin/plugins/:id/uninstall
 */
export async function uninstallMarketplacePlugin(
	id: string,
	opts: UninstallPluginOpts = {},
): Promise<void> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/${encodeURIComponent(id)}/uninstall`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(opts),
	});
	if (!response.ok) await throwResponseError(response, "Failed to uninstall plugin");
}

/**
 * Check all marketplace plugins for available updates.
 * GET /_emdash/api/admin/plugins/updates
 */
export async function checkPluginUpdates(): Promise<PluginUpdateInfo[]> {
	const response = await apiFetch(`${API_BASE}/admin/plugins/updates`);
	const result = await parseApiResponse<{ items: PluginUpdateInfo[] }>(
		response,
		"Failed to check for updates",
	);
	return result.items;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable labels for plugin capabilities */
export const CAPABILITY_LABELS: Record<string, string> = {
	"read:content": "Read your content",
	"write:content": "Create, update, and delete content",
	"read:media": "Access your media library",
	"write:media": "Upload and manage media",
	"network:fetch": "Make network requests",
	"network:fetch:any": "Make network requests to any host (unrestricted)",
};

/**
 * Get a human-readable description for a capability.
 * For network:fetch, appends the allowed hosts if provided.
 */
export function describeCapability(capability: string, allowedHosts?: string[]): string {
	const base = CAPABILITY_LABELS[capability] ?? capability;
	if (capability === "network:fetch" && allowedHosts && allowedHosts.length > 0) {
		return `${base} to: ${allowedHosts.join(", ")}`;
	}
	return base;
}
