/**
 * Dashboard stats API
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

export interface CollectionStats {
	slug: string;
	label: string;
	total: number;
	published: number;
	draft: number;
	scheduled: number;
	overdueScheduled?: number;
}

export interface RecentItem {
	id: string;
	collection: string;
	collectionLabel: string;
	title: string;
	slug: string | null;
	status: string;
	updatedAt: string;
	authorId: string | null;
}

export interface DashboardStats {
	collections: CollectionStats[];
	mediaCount: number;
	userCount: number;
	recentItems: RecentItem[];
	schedulerHealth?: {
		status: "healthy" | "stale" | "unknown";
		lastCompletedAt: string | null;
	};
	policyRejectedScheduled?: number;
	policyRejections?: Array<{
		collection: string;
		id: string;
		pluginId: string;
		reason: string;
		rejectedAt: string;
		_rev: string;
	}>;
}

/**
 * Fetch dashboard statistics
 */
export async function fetchDashboardStats(): Promise<DashboardStats> {
	const response = await apiFetch(`${API_BASE}/dashboard`);
	return parseApiResponse<DashboardStats>(response, i18n._(msg`Failed to fetch dashboard stats`));
}

export async function dismissScheduledPolicyRejection(
	collection: string,
	id: string,
	revision: string,
): Promise<void> {
	const response = await apiFetch(
		`${API_BASE}/admin/scheduled-policy-rejections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}?rev=${encodeURIComponent(revision)}`,
		{ method: "DELETE" },
	);
	if (!response.ok) {
		await throwResponseError(
			response,
			i18n._(msg`Failed to dismiss scheduled publication rejection`),
		);
	}
}
