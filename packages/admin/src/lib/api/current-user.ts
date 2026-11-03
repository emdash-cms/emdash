/**
 * Current user query — shared across Shell, Header, Sidebar, and CommandPalette.
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { apiFetch, parseApiResponse } from "./client.js";

export const currentUserQueryKey = ["currentUser"] as const;

export interface CurrentUser {
	id: string;
	email: string;
	name?: string;
	role: number;
	avatarUrl?: string;
	isFirstLogin?: boolean;
	/**
	 * The stored sidebar layout as the server sent it. Read it through
	 * `useAdminLayout()`, which validates it and adds unsaved changes. Absent
	 * from older servers and most test mocks, which means "none".
	 */
	adminLayout?: unknown;
}

async function fetchCurrentUser(): Promise<CurrentUser> {
	const response = await apiFetch("/_emdash/api/auth/me");
	return parseApiResponse<CurrentUser>(response, i18n._(msg`Failed to fetch user`));
}

export function currentUserQueryOptions() {
	return queryOptions({
		queryKey: currentUserQueryKey,
		queryFn: fetchCurrentUser,
		staleTime: 5 * 60 * 1000,
		retry: false,
	});
}

export function useCurrentUser() {
	return useQuery(currentUserQueryOptions());
}
