import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { SecuritySettings } from "../../../src/components/settings/SecuritySettings";
import { render } from "../../utils/render";

const mockFetchManifest = vi.fn();
const mockFetchPasskeys = vi.fn();
const mockRenamePasskey = vi.fn();
const mockDeletePasskey = vi.fn();

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

vi.mock("../../../src/lib/api", async () => {
	const actual = await vi.importActual("../../../src/lib/api");
	return {
		...actual,
		fetchManifest: (...args: unknown[]) => mockFetchManifest(...args),
		fetchPasskeys: (...args: unknown[]) => mockFetchPasskeys(...args),
		renamePasskey: (...args: unknown[]) => mockRenamePasskey(...args),
		deletePasskey: (...args: unknown[]) => mockDeletePasskey(...args),
	};
});

vi.mock("../../../src/components/auth/PasskeyRegistration", () => ({
	PasskeyRegistration: ({ onError }: { onError?: (error: Error) => void }) => (
		<button
			type="button"
			onClick={() => onError?.(new Error("Authenticator rejected registration"))}
		>
			Simulate registration error
		</button>
	),
}));

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<Toasty>
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		</Toasty>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchManifest.mockResolvedValue({
		authMode: "passkey",
		collections: {},
		plugins: {},
		version: "1",
		hash: "",
	});
	mockFetchPasskeys.mockResolvedValue([]);
	mockRenamePasskey.mockResolvedValue({});
	mockDeletePasskey.mockResolvedValue({});
});

describe("SecuritySettings", () => {
	it("shows the shared loading recipe while auth data is loading", async () => {
		mockFetchManifest.mockImplementationOnce(() => new Promise(() => {}));
		const screen = await render(
			<QueryWrapper>
				<SecuritySettings />
			</QueryWrapper>,
		);

		await expect.element(screen.getByText("Loading...")).toBeInTheDocument();
	});

	it("passkey registration errors show a stable title and detail toast", async () => {
		const screen = await render(
			<QueryWrapper>
				<SecuritySettings />
			</QueryWrapper>,
		);

		await expect.element(screen.getByText("Add Passkey")).toBeInTheDocument();
		await userEvent.click(screen.getByText("Add Passkey"));
		await userEvent.click(screen.getByText("Simulate registration error"));

		await expect.element(screen.getByText("Failed to add passkey")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Authenticator rejected registration"))
			.toBeInTheDocument();
	});

	it("renames an existing passkey", async () => {
		mockFetchPasskeys.mockResolvedValue([
			{
				id: "passkey-1",
				name: "Laptop",
				deviceType: "multiDevice",
				backedUp: true,
				createdAt: "2025-01-01T00:00:00Z",
				lastUsedAt: "2025-01-02T00:00:00Z",
			},
		]);
		const screen = await render(
			<QueryWrapper>
				<SecuritySettings />
			</QueryWrapper>,
		);

		await expect.element(screen.getByText("Laptop")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Rename Laptop" }).click();
		const input = screen.getByPlaceholder("Passkey name");
		await input.fill("Work laptop");
		await screen.getByRole("button", { name: "Save name" }).click();

		await vi.waitFor(() =>
			expect(mockRenamePasskey).toHaveBeenCalledWith("passkey-1", "Work laptop"),
		);
		await expect.element(screen.getByText("Passkey renamed")).toBeInTheDocument();
	});

	it("requires confirmation before deleting a passkey", async () => {
		mockFetchPasskeys.mockResolvedValue([
			{
				id: "passkey-1",
				name: "Laptop",
				deviceType: "multiDevice",
				backedUp: true,
				createdAt: "2025-01-01T00:00:00Z",
				lastUsedAt: "2025-01-02T00:00:00Z",
			},
			{
				id: "passkey-2",
				name: "Phone",
				deviceType: "singleDevice",
				backedUp: false,
				createdAt: "2025-01-03T00:00:00Z",
				lastUsedAt: "2025-01-04T00:00:00Z",
			},
		]);
		const screen = await render(
			<QueryWrapper>
				<SecuritySettings />
			</QueryWrapper>,
		);

		await screen.getByRole("button", { name: "Remove Laptop" }).click();
		await expect.element(screen.getByText("Remove passkey?")).toBeInTheDocument();
		screen.getByRole("button", { name: "Remove" }).element().click();

		await vi.waitFor(() => expect(mockDeletePasskey).toHaveBeenCalledWith("passkey-1"));
	});
});
