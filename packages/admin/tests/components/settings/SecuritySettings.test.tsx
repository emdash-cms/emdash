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
});
