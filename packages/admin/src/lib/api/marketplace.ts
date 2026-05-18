/**
 * Marketplace API client
 *
 * Calls the site-side proxy endpoints (/_emdash/api/admin/plugins/marketplace/*)
 * which forward to the marketplace Worker. This avoids CORS issues since the
 * admin UI doesn't need to know the marketplace URL.
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

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
	sort?: "installs" | "updated" | "created" | "name";
	cursor?: string;
	limit?: number;
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
	if (opts.sort) params.set("sort", opts.sort);
	if (opts.cursor) params.set("cursor", opts.cursor);
	if (opts.limit) params.set("limit", String(opts.limit));

	const qs = params.toString();
	const url = `${MARKETPLACE_BASE}${qs ? `?${qs}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<MarketplaceSearchResult>(response, "Marketplace search failed");
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
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to install plugin`));
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
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to update plugin`));
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
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to uninstall plugin`));
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

/**
 * Human-readable labels for plugin capabilities.
 *
 * Canonical names are the keys; legacy names alias to the same labels so
 * old manifests still render meaningful copy until they're republished.
 */
import type { MessageDescriptor } from "@lingui/core";

export const CAPABILITY_LABELS: Record<string, MessageDescriptor> = {
	// Canonical
	"content:read": msg`Read your content`,
	"content:write": msg`Create, update, and delete content`,
	"media:read": msg`Access your media library`,
	"media:write": msg`Upload and manage media`,
	"users:read": msg`Read user accounts`,
	"network:request": msg`Make network requests`,
	"network:request:unrestricted": msg`Make network requests to any host (unrestricted)`,
	// Legacy aliases (still emitted by older installed manifests)
	"read:content": msg`Read your content`,
	"write:content": msg`Create, update, and delete content`,
	"read:media": msg`Access your media library`,
	"write:media": msg`Upload and manage media`,
	"read:users": msg`Read user accounts`,
	"network:fetch": msg`Make network requests`,
	"network:fetch:any": msg`Make network requests to any host (unrestricted)`,
};

/** Capability names that grant scoped network access (legacy + canonical). */
const NETWORK_REQUEST_CAPABILITIES = new Set(["network:request", "network:fetch"]);

/**
 * Get a human-readable description for a capability.
 * For scoped network capabilities, appends the allowed hosts if provided.
 *
 * Module-scope so calls outside React components work; uses the global i18n
 * instance for translation. Components that have access to `useLingui` can
 * also resolve `CAPABILITY_LABELS[capability]` directly with `t(...)` if they
 * need the translated string without the host suffix.
 */
export function describeCapability(capability: string, allowedHosts?: string[]): string {
	const descriptor = CAPABILITY_LABELS[capability];
	const base = descriptor ? i18n._(descriptor) : capability;
	if (NETWORK_REQUEST_CAPABILITIES.has(capability) && allowedHosts && allowedHosts.length > 0) {
		return i18n._(msg`${base} to: ${allowedHosts.join(", ")}`);
	}
	return base;
}
