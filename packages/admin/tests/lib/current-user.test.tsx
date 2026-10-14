import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { apiFetch } from "../../src/lib/api/client";
import { refetchCurrentUserOnForbidden, useCurrentUser } from "../../src/lib/api/current-user";
import { createMockFetch, createTestQueryClient } from "../utils/test-helpers";

const ROLE_EDITOR = 40;
const ROLE_ADMIN = 50;

function UsersNavItem() {
	const { data: user } = useCurrentUser();
	if (!user) return null;
	return <span data-testid="users-nav">{user.role >= ROLE_ADMIN ? "shown" : "hidden"}</span>;
}

describe("current user role after a role change on the server", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;
	let queryClient: QueryClient;
	let stopRefetching: () => void;

	function setServerRole(role: number) {
		mockFetch.on("GET", "/_emdash/api/auth/me", {
			data: { id: "user_01", email: "bob@example.com", role },
		});
	}

	beforeEach(() => {
		mockFetch = createMockFetch();
		setServerRole(ROLE_ADMIN);
		queryClient = createTestQueryClient();
		stopRefetching = refetchCurrentUserOnForbidden(queryClient);
	});

	afterEach(() => {
		stopRefetching();
		queryClient.clear();
		mockFetch.restore();
	});

	async function renderUsersNavItem() {
		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<UsersNavItem />
			</QueryClientProvider>,
		);
		await expect.element(screen.getByTestId("users-nav")).toHaveTextContent("shown");
		return screen;
	}

	it("hides admin-only navigation once the server refuses a request", async () => {
		const screen = await renderUsersNavItem();

		setServerRole(ROLE_EDITOR);
		mockFetch.on(
			"GET",
			"/_emdash/api/admin/users",
			{ error: { code: "FORBIDDEN", message: "Admin privileges required" } },
			403,
		);
		const response = await apiFetch("/_emdash/api/admin/users");
		expect(response.status).toBe(403);

		await expect.element(screen.getByTestId("users-nav")).toHaveTextContent("hidden");
	});

	it("picks up the new role when the user returns to the tab", async () => {
		const screen = await renderUsersNavItem();

		setServerRole(ROLE_EDITOR);
		window.dispatchEvent(new Event("visibilitychange"));

		await expect.element(screen.getByTestId("users-nav")).toHaveTextContent("hidden");
	});
});
