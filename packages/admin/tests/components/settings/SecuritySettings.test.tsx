import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { SecuritySettings } from "../../../src/components/settings/SecuritySettings";
import type { PasskeyInfo } from "../../../src/lib/api";
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
	PasskeyRegistration: ({
		onError,
		onSuccess,
	}: {
		onError?: (error: Error) => void;
		onSuccess?: () => void;
	}) => (
		<div>
			<button
				type="button"
				onClick={() => onError?.(new Error("Authenticator rejected registration"))}
			>
				Simulate registration error
			</button>
			<button type="button" onClick={() => onSuccess?.()}>
				Simulate registration success
			</button>
		</div>
	),
}));

const passkeys: PasskeyInfo[] = [
	{
		id: "passkey-1",
		name: "Laptop",
		deviceType: "multiDevice",
		backedUp: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		lastUsedAt: "2026-01-02T00:00:00.000Z",
	},
	{
		id: "passkey-2",
		name: "Phone",
		deviceType: "singleDevice",
		backedUp: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		lastUsedAt: "2026-01-02T00:00:00.000Z",
	},
];

function QueryWrapper({ children }: { children: React.ReactNode }) {
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

async function renderSecuritySettings() {
	return render(
		<QueryWrapper>
			<SecuritySettings />
		</QueryWrapper>,
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
	mockDeletePasskey.mockResolvedValue(undefined);
});

describe("SecuritySettings", () => {
	it("shows the shared frame while the manifest loads", async () => {
		mockFetchManifest.mockReturnValue(new Promise(() => undefined));
		const screen = await renderSecuritySettings();

		await expect
			.element(screen.getByRole("heading", { name: "Security Settings", level: 1 }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Loading...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add Passkey" }).query()).toBeNull();
	});

	it("shows the external-auth state without fetching passkeys", async () => {
		mockFetchManifest.mockResolvedValue({
			authMode: "cloudflare-access",
			collections: {},
			plugins: {},
			version: "1",
			hash: "",
		});
		const screen = await renderSecuritySettings();

		await expect.element(screen.getByRole("status")).toHaveTextContent("Security Settings");
		expect(mockFetchPasskeys).not.toHaveBeenCalled();
	});

	it("shows a passkey load failure without management actions", async () => {
		mockFetchPasskeys.mockRejectedValue(new Error("Passkey service unavailable"));
		const screen = await renderSecuritySettings();

		await expect.element(screen.getByRole("alert")).toHaveTextContent("Failed to load passkeys");
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Passkey service unavailable");
		expect(screen.getByRole("button", { name: "Add Passkey" }).query()).toBeNull();
	});

	it("shows the empty state and registration errors", async () => {
		const screen = await renderSecuritySettings();

		await expect.element(screen.getByText("No passkeys registered yet.")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Add Passkey" }));
		await userEvent.click(screen.getByRole("button", { name: "Simulate registration error" }));

		await expect.element(screen.getByText("Failed to add passkey")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Authenticator rejected registration"))
			.toBeInTheDocument();
	});

	it("closes registration after success", async () => {
		const screen = await renderSecuritySettings();
		await userEvent.click(screen.getByRole("button", { name: "Add Passkey" }));
		await userEvent.click(screen.getByRole("button", { name: "Simulate registration success" }));

		await expect.element(screen.getByText("Passkey added successfully")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Add Passkey" })).toBeInTheDocument();
	});

	it("renames an existing passkey", async () => {
		mockFetchPasskeys.mockResolvedValue(passkeys);
		const screen = await renderSecuritySettings();
		await expect.element(screen.getByText("Laptop")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Rename Laptop" }));
		await screen.getByPlaceholder("Passkey name").fill("Office key");
		await userEvent.click(screen.getByRole("button", { name: "Save name" }));

		await vi.waitFor(() => {
			expect(mockRenamePasskey).toHaveBeenCalledWith("passkey-1", "Office key");
		});
		await expect.element(screen.getByText("Passkey renamed")).toBeInTheDocument();
	});

	it("formats passkey activity in the active locale", async () => {
		const previousLocale = i18n.locale;
		const lastUsedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		const oldLastUsedAt = "2020-01-02T00:00:00.000Z";
		const expectedRelativeTime = new Intl.RelativeTimeFormat("ar", { numeric: "auto" }).format(
			-5,
			"minute",
		);
		const expectedDate = new Date(oldLastUsedAt).toLocaleDateString("ar", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
		mockFetchPasskeys.mockResolvedValue([
			{ ...passkeys[0], lastUsedAt },
			{ ...passkeys[1], lastUsedAt: oldLastUsedAt },
		]);
		i18n.activate("ar");

		try {
			const screen = await renderSecuritySettings();
			await expect.element(screen.getByText(expectedRelativeTime)).toBeInTheDocument();
			await expect.element(screen.getByText(expectedDate)).toBeInTheDocument();
		} finally {
			i18n.activate(previousLocale);
		}
	});

	it("requires confirmation before deleting a passkey", async () => {
		mockFetchPasskeys.mockResolvedValue(passkeys);
		const screen = await renderSecuritySettings();
		await expect.element(screen.getByText("Laptop")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Remove Laptop" }));
		await expect
			.element(screen.getByRole("heading", { name: "Remove passkey?" }))
			.toBeInTheDocument();
		expect(mockDeletePasskey).not.toHaveBeenCalled();
		const confirmButton = screen
			.getByRole("button", { name: "Remove", exact: true })
			.element() as HTMLButtonElement;
		confirmButton.click();

		await vi.waitFor(() => {
			expect(mockDeletePasskey).toHaveBeenCalledWith("passkey-1");
		});
		await expect.element(screen.getByText("Passkey removed")).toBeInTheDocument();
	});
});
