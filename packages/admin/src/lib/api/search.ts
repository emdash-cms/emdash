/**
 * Search enable/disable APIs
 */

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

export interface SearchEnableResult {
	success: boolean;
	collection: string;
	enabled: boolean;
	indexed?: number;
}

/**
 * Enable or disable search for a collection
 */
export async function setSearchEnabled(
	collection: string,
	enabled: boolean,
	weights?: Record<string, number>,
): Promise<SearchEnableResult> {
	const response = await apiFetch(`${API_BASE}/search/enable`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ collection, enabled, weights }),
	});
	return parseApiResponse<SearchEnableResult>(
		response,
		`Failed to ${enabled ? "enable" : "disable"} search`,
	);
}
