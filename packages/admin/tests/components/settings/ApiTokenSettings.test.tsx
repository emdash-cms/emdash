import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render } from "../../utils/render";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

const mockFetchApiTokens = vi.fn();
const mockCreateApiToken = vi.fn();
const mockRevokeApiToken = vi.fn();
const mockFetchPlugins = vi.fn();

vi.mock("../../../src/lib/api/api-tokens", async () => {
	const actual = await vi.importActual("../../../src/lib/api/api-tokens");
	return {
		...actual,
		fetchApiTokens: (...args: unknown[]) => mockFetchApiTokens(...args),
		createApiToken: (...args: unknown[]) => mockCreateApiToken(...args),
		revokeApiToken: (...args: unknown[]) => mockRevokeApiToken(...args),
	};
});

vi.mock("../../../src/lib/api/plugins", async () => {
	const actual = await vi.importActual("../../../src/lib/api/plugins");
	return {
		...actual,
		fetchPlugins: (...args: unknown[]) => mockFetchPlugins(...args),
	};
});

const { ApiTokenSettings } = await import("../../../src/components/settings/ApiTokenSettings");

const TOKEN = {
	id: "token-1",
	name: "CI token",
	prefix: "emdash",
	scopes: ["content:read"],
	userId: "user-1",
	expiresAt: null,
	lastUsedAt: null,
	createdAt: "2025-01-01T00:00:00Z",
};

const CREATED_TOKEN = {
	token: "secret-token-value",
	info: TOKEN,
};

function Wrapper({ children }: { children: React.ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<Toasty>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</Toasty>
	);
}

describe("ApiTokenSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchApiTokens.mockResolvedValue([]);
		mockFetchPlugins.mockResolvedValue([]);
		mockCreateApiToken.mockResolvedValue(CREATED_TOKEN);
		mockRevokeApiToken.mockResolvedValue(undefined);
	});

	it("shows an empty state when no tokens exist", async () => {
		const screen = await render(
			<Wrapper>
				<ApiTokenSettings />
			</Wrapper>,
		);

		await expect
			.element(screen.getByText("No API tokens yet. Create one to get started."))
			.toBeInTheDocument();
	});

	it("creates a token and keeps one-time reveal behavior", async () => {
		const screen = await render(
			<Wrapper>
				<ApiTokenSettings />
			</Wrapper>,
		);

		await screen.getByRole("button", { name: "Create Token" }).click();
		await screen.getByLabelText("Token Name").fill("CI token");
		await screen.getByRole("checkbox").first().click();
		await screen.getByRole("button", { name: "Create Token" }).click();

		await vi.waitFor(() => expect(mockCreateApiToken).toHaveBeenCalledTimes(1));
		expect(mockCreateApiToken.mock.calls[0]![0].name).toBe("CI token");
		expect(mockCreateApiToken.mock.calls[0]![0].scopes).toEqual(["content:read"]);
		await expect.element(screen.getByLabelText("Show token")).toBeInTheDocument();
		await screen.getByLabelText("Show token").click();
		await expect.element(screen.getByText("secret-token-value")).toBeInTheDocument();
	});

	it("confirms revoke and surfaces revoke errors in the shared dialog", async () => {
		mockFetchApiTokens.mockResolvedValue([TOKEN]);
		mockRevokeApiToken.mockRejectedValueOnce(new Error("Token is already revoked"));
		const screen = await render(
			<Wrapper>
				<ApiTokenSettings />
			</Wrapper>,
		);

		await screen.getByRole("button", { name: "Revoke token" }).click();
		await expect.element(screen.getByText("Revoke token?")).toBeInTheDocument();
		screen.getByRole("button", { name: "Revoke" }).element().click();

		await expect.element(screen.getByText("Token is already revoked")).toBeInTheDocument();
	});

	it("shows load failures inline", async () => {
		mockFetchApiTokens.mockRejectedValueOnce(new Error("Token service unavailable"));
		const screen = await render(
			<Wrapper>
				<ApiTokenSettings />
			</Wrapper>,
		);

		await expect.element(screen.getByText("Token service unavailable")).toBeInTheDocument();
	});
});
