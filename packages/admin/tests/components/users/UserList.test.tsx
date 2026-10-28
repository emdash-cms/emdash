import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { UserList } from "../../../src/components/users/UserList";
import type { UserListItem } from "../../../src/lib/api";
import { render } from "../../utils/render";

function makeUser(overrides: Partial<UserListItem> = {}): UserListItem {
	return {
		id: "user-1",
		email: "ada@example.com",
		name: "Ada Lovelace",
		avatarUrl: null,
		role: 30,
		emailVerified: true,
		disabled: false,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-02T00:00:00Z",
		lastLogin: "2025-01-02T00:00:00Z",
		credentialCount: 1,
		oauthProviders: [],
		...overrides,
	};
}

const noop = () => {};

describe("UserList", () => {
	it("opens a user's details from the name button with the keyboard", async () => {
		const onSelectUser = vi.fn();
		const screen = await render(
			<UserList
				users={[makeUser()]}
				searchQuery=""
				roleFilter={undefined}
				onSearchChange={noop}
				onRoleFilterChange={noop}
				onSelectUser={onSelectUser}
				onInviteUser={noop}
			/>,
		);

		const nameButton = screen.getByRole("button", { name: "Ada Lovelace" }).element();
		for (let i = 0; i < 10 && document.activeElement !== nameButton; i++) {
			await userEvent.tab();
		}
		expect(document.activeElement).toBe(nameButton);

		await userEvent.keyboard("{Enter}");

		expect(onSelectUser).toHaveBeenCalledWith("user-1");
	});
});
