/**
 * Current user query — shared across Shell, Header, Sidebar, and CommandPalette.
 */

import { useQuery } from "@tanstack/react-query";

import { apiFetch, parseApiResponse } from "./client.js";

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
	return parseApiResponse<CurrentUser>(response, "Failed to fetch user");
}

export function useCurrentUser() {
	return useQuery({
		queryKey: ["currentUser"],
		queryFn: fetchCurrentUser,
		staleTime: 5 * 60 * 1000,
		retry: false,
	});
}
