import { useQuery } from "@tanstack/react-query";

import { fetchUsers, type UserListItem } from "../../../lib/api/users.js";

async function fetchAllUsers(): Promise<UserListItem[]> {
	const users: UserListItem[] = [];
	let cursor: string | undefined;
	do {
		const page = await fetchUsers({ limit: 100, cursor });
		users.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return users;
}

/** Every user on this site, for mapping authors and naming approval requesters. */
export function useTransferUsers() {
	return useQuery({ queryKey: ["users", "transfer"], queryFn: fetchAllUsers });
}
