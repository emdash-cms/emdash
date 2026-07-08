/**
 * Search enable/disable APIs
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

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
	const fallbackMessage = enabled
		? i18n._(msg`Failed to enable search`)
		: i18n._(msg`Failed to disable search`);
	return parseApiResponse<SearchEnableResult>(response, fallbackMessage);
}
