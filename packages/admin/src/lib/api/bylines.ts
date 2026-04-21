import {
	API_BASE,
	apiFetch,
	parseApiResponse,
	throwResponseError,
	type FindManyResult,
} from "./client.js";

export interface BylineSummary {
	id: string;
	slug: string;
	displayName: string;
	bio: string | null;
	avatarMediaId: string | null;
	websiteUrl: string | null;
	userId: string | null;
	isGuest: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface BylineInput {
	slug: string;
	displayName: string;
	bio?: string | null;
	avatarMediaId?: string | null;
	websiteUrl?: string | null;
	userId?: string | null;
	isGuest?: boolean;
}

export interface BylineCreditInput {
	bylineId: string;
	roleLabel?: string | null;
}

export async function fetchBylines(options?: {
	search?: string;
	isGuest?: boolean;
	userId?: string;
	cursor?: string;
	limit?: number;
}): Promise<FindManyResult<BylineSummary>> {
	const params = new URLSearchParams();
	if (options?.search) params.set("search", options.search);
	if (options?.isGuest !== undefined) params.set("isGuest", String(options.isGuest));
	if (options?.userId) params.set("userId", options.userId);
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit) params.set("limit", String(options.limit));

	const url = `${API_BASE}/admin/bylines${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<FindManyResult<BylineSummary>>(response, "Failed to fetch bylines");
}

export async function fetchByline(id: string): Promise<BylineSummary> {
	const response = await apiFetch(`${API_BASE}/admin/bylines/${id}`);
	return parseApiResponse<BylineSummary>(response, "Failed to fetch byline");
}

export async function createByline(input: BylineInput): Promise<BylineSummary> {
	const response = await apiFetch(`${API_BASE}/admin/bylines`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<BylineSummary>(response, "Failed to create byline");
}

export async function updateByline(
	id: string,
	input: Partial<BylineInput>,
): Promise<BylineSummary> {
	const response = await apiFetch(`${API_BASE}/admin/bylines/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<BylineSummary>(response, "Failed to update byline");
}

export async function deleteByline(id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/admin/bylines/${id}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, "Failed to delete byline");
}
