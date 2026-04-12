/**
 * Redirects API client
 */

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

export interface Redirect {
	id: string;
	source: string;
	destination: string;
	type: number;
	isPattern: boolean;
	enabled: boolean;
	hits: number;
	lastHitAt: string | null;
	groupName: string | null;
	auto: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface NotFoundSummary {
	path: string;
	count: number;
	lastSeen: string;
	topReferrer: string | null;
}

export interface CreateRedirectInput {
	source: string;
	destination: string;
	type?: number;
	enabled?: boolean;
	groupName?: string | null;
}

export interface UpdateRedirectInput {
	source?: string;
	destination?: string;
	type?: number;
	enabled?: boolean;
	groupName?: string | null;
}

export interface RedirectListOptions {
	cursor?: string;
	limit?: number;
	search?: string;
	group?: string;
	enabled?: boolean;
	auto?: boolean;
}

export interface RedirectListResult {
	items: Redirect[];
	nextCursor?: string;
	loopRedirectIds?: string[];
}

/**
 * List redirects with optional filters
 */
export async function fetchRedirects(options?: RedirectListOptions): Promise<RedirectListResult> {
	const params = new URLSearchParams();
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit != null) params.set("limit", String(options.limit));
	if (options?.search) params.set("search", options.search);
	if (options?.group) params.set("group", options.group);
	if (options?.enabled !== undefined) params.set("enabled", String(options.enabled));
	if (options?.auto !== undefined) params.set("auto", String(options.auto));

	const url = params.toString() ? `${API_BASE}/redirects?${params}` : `${API_BASE}/redirects`;
	const response = await apiFetch(url);
	return parseApiResponse<RedirectListResult>(response, "Failed to fetch redirects");
}

/**
 * Create a redirect
 */
export async function createRedirect(input: CreateRedirectInput): Promise<Redirect> {
	const response = await apiFetch(`${API_BASE}/redirects`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<Redirect>(response, "Failed to create redirect");
}

/**
 * Update a redirect
 */
export async function updateRedirect(id: string, input: UpdateRedirectInput): Promise<Redirect> {
	const response = await apiFetch(`${API_BASE}/redirects/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<Redirect>(response, "Failed to update redirect");
}

/**
 * Delete a redirect
 */
export async function deleteRedirect(id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/redirects/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, "Failed to delete redirect");
}

/**
 * Fetch 404 summary (grouped by path, sorted by count)
 */
export async function fetch404Summary(limit?: number): Promise<NotFoundSummary[]> {
	const params = new URLSearchParams();
	if (limit != null) params.set("limit", String(limit));

	const url = params.toString()
		? `${API_BASE}/redirects/404s/summary?${params}`
		: `${API_BASE}/redirects/404s/summary`;
	const response = await apiFetch(url);
	const data = await parseApiResponse<{ items: NotFoundSummary[] }>(
		response,
		"Failed to fetch 404 summary",
	);
	return data.items;
}
