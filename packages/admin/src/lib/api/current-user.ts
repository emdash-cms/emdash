/**
 * Current user query — shared across Shell, Header, Sidebar, and CommandPalette.
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { apiFetch, onForbiddenResponse, parseApiResponse } from "./client.js";

export interface CurrentUser {
	id: string;
	email: string;
	name?: string;
	role: number;
	avatarUrl?: string;
	isFirstLogin?: boolean;
}

async function fetchCurrentUser(): Promise<CurrentUser> {
	const response = await apiFetch("/_emdash/api/auth/me");
	return parseApiResponse<CurrentUser>(response, i18n._(msg`Failed to fetch user`));
}

export function useCurrentUser() {
	return useQuery({
		queryKey: ["currentUser"],
		queryFn: fetchCurrentUser,
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: "always",
		retry: false,
	});
}

/**
 * Refetches the current user whenever the server refuses a request. The
 * server checks the user's role on every request, so a 403 can mean the
 * cached role is out of date. Returns a function that stops listening.
 */
export function refetchCurrentUserOnForbidden(queryClient: QueryClient): () => void {
	return onForbiddenResponse(() => {
		void queryClient.invalidateQueries(
			{ queryKey: ["currentUser"], exact: true },
			{ cancelRefetch: false },
		);
	});
}
