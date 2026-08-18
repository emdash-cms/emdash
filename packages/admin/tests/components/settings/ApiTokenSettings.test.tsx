import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type {
	ApiTokenCreateResult,
	ApiTokenInfo,
	CreateApiTokenInput,
} from "../../../src/lib/api/api-tokens.js";
import { render } from "../../utils/render.js";

const mockFetchApiTokens = vi.fn<() => Promise<ApiTokenInfo[]>>();
const mockCreateApiToken = vi.fn<(input: CreateApiTokenInput) => Promise<ApiTokenCreateResult>>();
const mockRevokeApiToken = vi.fn<(id: string) => Promise<void>>();
const mockFetchPlugins = vi.fn();

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
	};
});

vi.mock("../../../src/lib/api/api-tokens.js", async () => {
	const actual = await vi.importActual("../../../src/lib/api/api-tokens.js");
	return {
		...actual,
		fetchApiTokens: () => mockFetchApiTokens(),
		createApiToken: (input: CreateApiTokenInput) => mockCreateApiToken(input),
		revokeApiToken: (id: string) => mockRevokeApiToken(id),
	};
});

vi.mock("../../../src/lib/api/plugins.js", async () => {
	const actual = await vi.importActual("../../../src/lib/api/plugins.js");
	return {
		...actual,
		fetchPlugins: () => mockFetchPlugins(),
	};
});

const { ApiTokenSettings } = await import("../../../src/components/settings/ApiTokenSettings.js");

const token: ApiTokenInfo = {
	id: "token-1",
	name: "CI token",
	prefix: "emd_abc",
	scopes: ["content:read"],
	userId: "user-1",
	expiresAt: "2027-01-01T00:00:00.000Z",
	lastUsedAt: null,
	createdAt: "2026-01-01T00:00:00.000Z",
};

const createdToken: ApiTokenCreateResult = {
	token: "emd_secret-token-value",
	info: token,
};

function Wrapper({ children }: { children: React.ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<Toasty>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</Toasty>
	);
}

async function renderApiTokenSettings() {
	return render(<ApiTokenSettings />, { wrapper: Wrapper });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchApiTokens.mockResolvedValue([]);
	mockFetchPlugins.mockResolvedValue([]);
	mockCreateApiToken.mockResolvedValue(createdToken);
	mockRevokeApiToken.mockResolvedValue(undefined);
});

describe("ApiTokenSettings", () => {
	it("shows the shared frame while tokens load", async () => {
		mockFetchApiTokens.mockReturnValue(new Promise(() => undefined));
		const screen = await renderApiTokenSettings();

		await expect
			.element(screen.getByRole("heading", { name: "API Tokens", level: 1 }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Loading...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create Token" }).query()).toBeNull();
	});

	it("shows a load failure without token actions", async () => {
		mockFetchApiTokens.mockRejectedValue(new Error("Token service unavailable"));
		const screen = await renderApiTokenSettings();

		await expect.element(screen.getByRole("alert")).toHaveTextContent("An error occurred");
		await expect.element(screen.getByRole("alert")).toHaveTextContent("Token service unavailable");
		expect(screen.getByRole("button", { name: "Create Token" }).query()).toBeNull();
	});

	it("shows the empty state and opens the creation form", async () => {
		const screen = await renderApiTokenSettings();

		await expect
			.element(screen.getByText("No API tokens yet. Create one to get started."))
			.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Create Token" }));
		await expect.element(screen.getByRole("textbox", { name: "Token Name" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Create Token" })).toBeDisabled();
	});

	it("creates a token and preserves its one-time reveal flow", async () => {
		const clipboardWrite = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
		const screen = await renderApiTokenSettings();
		await userEvent.click(screen.getByRole("button", { name: "Create Token" }));
		await screen.getByRole("textbox", { name: "Token Name" }).fill(" CI token ");
		await userEvent.click(screen.getByRole("checkbox", { name: /Content Read/ }));
		await userEvent.click(screen.getByRole("button", { name: "Create Token" }));

		await vi.waitFor(() => {
			expect(mockCreateApiToken).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "CI token",
					scopes: ["content:read"],
					expiresAt: expect.any(String),
				}),
			);
		});
		await expect.element(screen.getByText("Token created: CI token")).toBeInTheDocument();
		expect(screen.getByText("emd_secret-token-value").query()).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "Show token" }));
		await expect.element(screen.getByText("emd_secret-token-value")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Hide token" })).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Copy token" }));
		expect(clipboardWrite).toHaveBeenCalledWith("emd_secret-token-value");
		await expect.element(screen.getByText("Copied to clipboard")).toBeInTheDocument();
		clipboardWrite.mockRestore();
	});

	it("keeps the one-time token visible when the token list refetch fails", async () => {
		mockFetchApiTokens
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new Error("Token list refetch failed"));
		const screen = await renderApiTokenSettings();

		await userEvent.click(screen.getByRole("button", { name: "Create Token" }));
		await screen.getByRole("textbox", { name: "Token Name" }).fill("CI token");
		await userEvent.click(screen.getByRole("checkbox", { name: /Content Read/ }));
		await userEvent.click(screen.getByRole("button", { name: "Create Token" }));

		await vi.waitFor(() => expect(mockFetchApiTokens.mock.calls.length).toBeGreaterThanOrEqual(2));
		await expect.element(screen.getByText("Token created: CI token")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Show token" })).toBeInTheDocument();
		expect(screen.getByRole("alert").query()).toBeNull();
	});

	it("shows the created date from the stored UTC instant, not the viewer's local zone", async () => {
		const storedCreatedAt = "2026-05-20 02:00:00";
		const format = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
		const correct = format.format(new Date(Date.UTC(2026, 4, 20, 2, 0, 0)));
		const localMisread = format.format(new Date(storedCreatedAt));
		expect(correct).not.toBe(localMisread);

		mockFetchApiTokens.mockResolvedValue([{ ...token, createdAt: storedCreatedAt }]);
		const screen = await renderApiTokenSettings();

		await expect.element(screen.getByText("CI token")).toBeInTheDocument();
		await expect.element(screen.getByText(correct)).toBeInTheDocument();
		expect(screen.getByText(localMisread).query()).toBeNull();
	});

	it("requires confirmation before revoking a token", async () => {
		mockFetchApiTokens.mockResolvedValue([token]);
		const screen = await renderApiTokenSettings();
		await expect.element(screen.getByText("CI token")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Revoke token CI token" }));
		await expect.element(screen.getByRole("heading", { name: "Revoke?" })).toBeInTheDocument();
		expect(mockRevokeApiToken).not.toHaveBeenCalled();
		screen.getByRole("button", { name: "Confirm" }).element().click();

		await vi.waitFor(() => {
			expect(mockRevokeApiToken).toHaveBeenCalledWith("token-1");
		});
	});

	it("keeps the revoke dialog open and displays mutation errors", async () => {
		mockFetchApiTokens.mockResolvedValue([token]);
		mockRevokeApiToken.mockRejectedValue(new Error("Token is still in use"));
		const screen = await renderApiTokenSettings();
		await expect.element(screen.getByText("CI token")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Revoke token CI token" }));
		screen.getByRole("button", { name: "Confirm" }).element().click();

		await expect.element(screen.getByRole("alert")).toHaveTextContent("Token is still in use");
		await expect.element(screen.getByRole("heading", { name: "Revoke?" })).toBeInTheDocument();
	});
});
