/**
 * Dashboard stats API
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

export interface CollectionStats {
	slug: string;
	label: string;
	total: number;
	published: number;
	draft: number;
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
}

/**
 * Fetch dashboard statistics
 */
export async function fetchDashboardStats(): Promise<DashboardStats> {
	const response = await apiFetch(`${API_BASE}/dashboard`);
	return parseApiResponse<DashboardStats>(response, i18n._(msg`Failed to fetch dashboard stats`));
}
