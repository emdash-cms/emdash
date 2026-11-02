import * as React from "react";
import { describe, expect, it } from "vitest";

import "../../../dist/styles.css";
import { UserList } from "../../../src/components/users/UserList.js";
import type { UserListItem } from "../../../src/lib/api/index.js";
import { render } from "../../utils/render.js";

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

const PORTRAIT_AVATAR =
	"data:image/svg+xml," +
	encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="64"/>');

const users = [
	makeUser(),
	makeUser({
		id: "user-2",
		name: "Maya Chen",
		email: "maya.chen.longformaddress@marketingdepartment.example.com",
		avatarUrl: PORTRAIT_AVATAR,
		role: 40,
	}),
	makeUser({
		id: "user-3",
		name: "Jonas Weber",
		email: "jonas.weber.longformaddress@marketingdepartment.example.com",
		disabled: true,
	}),
];

const noop = () => {};

async function renderUserList(width: number) {
	const screen = await render(
		<div style={{ width }}>
			<UserList
				users={users}
				searchQuery=""
				roleFilter={undefined}
				onSearchChange={noop}
				onRoleFilterChange={noop}
				onSelectUser={noop}
				onInviteUser={noop}
			/>
		</div>,
	);
	const table = screen.getByRole("table").element() as HTMLTableElement;
	const userCell = (name: string) =>
		screen.getByRole("button", { name, exact: true }).element().closest("td")!;
	const visibleRowText = (name: string) => userCell(name).closest("tr")!.innerText;
	return { screen, tray: table.parentElement!, userCell, visibleRowText };
}

describe("UserList layout", () => {
	it("keeps each user's role and disabled state in a phone-width table", async () => {
		const { screen, tray, userCell, visibleRowText } = await renderUserList(360);
		const photo = userCell("Maya Chen").querySelector("img")!;
		await photo.decode();

		expect(visibleRowText("Jonas Weber")).toContain("Disabled");
		expect(visibleRowText("Ada Lovelace")).not.toMatch(/Active|Disabled/);
		expect(userCell("Ada Lovelace").innerText).toContain("Author");
		expect(userCell("Maya Chen").innerText).toContain("Editor");
		expect(
			screen.getByRole("columnheader", { name: "Status", includeHidden: true }).element(),
		).not.toBeVisible();
		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);

		const avatars = [
			photo,
			screen.getByText("A", { exact: true }).element(),
			screen.getByText("J", { exact: true }).element(),
		];
		for (const avatar of avatars) {
			const { width, height } = avatar.getBoundingClientRect();
			expect(width).toBeCloseTo(height, 0);
		}
	});

	it("shows each user's status in its own column in a wide table", async () => {
		const { screen, visibleRowText } = await renderUserList(900);

		await expect.element(screen.getByRole("columnheader", { name: "Status" })).toBeVisible();
		expect(visibleRowText("Ada Lovelace")).toContain("Active");
	});
});
