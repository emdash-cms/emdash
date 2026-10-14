import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { apiFetch } from "../../src/lib/api/client";
import { refetchCurrentUserOnForbidden, useCurrentUser } from "../../src/lib/api/current-user";

const ROLE_EDITOR = 40;
const ROLE_ADMIN = 50;

function UsersNavItem() {
	const { data: user } = useCurrentUser();
	if (!user) return null;
	return <span data-testid="users-nav">{user.role >= ROLE_ADMIN ? "shown" : "hidden"}</span>;
}

describe("current user role after a role change on the server", () => {
	const originalFetch = globalThis.fetch;
	let serverRole: number;
	let queryClient: QueryClient;
	let stopRefetching: () => void;

	beforeEach(() => {
		serverRole = ROLE_ADMIN;
		globalThis.fetch = async (input) => {
			const rawUrl =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const { pathname } = new URL(rawUrl, "http://localhost");
			if (pathname === "/_emdash/api/auth/me") {
				return Response.json({
					data: { id: "user_01", email: "bob@example.com", role: serverRole },
				});
			}
			if (pathname === "/_emdash/api/admin/users" && serverRole < ROLE_ADMIN) {
				return Response.json(
					{ error: { code: "FORBIDDEN", message: "Admin privileges required" } },
					{ status: 403 },
				);
			}
			return Response.json({ data: { items: [] } });
		};
		queryClient = new QueryClient({
			defaultOptions: { queries: { staleTime: 60 * 1000, retry: false } },
		});
		stopRefetching = refetchCurrentUserOnForbidden(queryClient);
	});

	afterEach(() => {
		stopRefetching();
		queryClient.clear();
		globalThis.fetch = originalFetch;
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

		serverRole = ROLE_EDITOR;
		const response = await apiFetch("/_emdash/api/admin/users");
		expect(response.status).toBe(403);

		await expect.element(screen.getByTestId("users-nav")).toHaveTextContent("hidden");
	});

	it("picks up the new role when the user returns to the tab", async () => {
		const screen = await renderUsersNavItem();

		serverRole = ROLE_EDITOR;
		window.dispatchEvent(new Event("visibilitychange"));

		await expect.element(screen.getByTestId("users-nav")).toHaveTextContent("hidden");
	});
});
