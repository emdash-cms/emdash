import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { AllowedDomainsSettings } from "../../../src/components/settings/AllowedDomainsSettings";
import type { AllowedDomain } from "../../../src/lib/api";
import { render } from "../../utils/render";

const mockFetchManifest = vi.fn();
const mockFetchAllowedDomains = vi.fn();
const mockCreateAllowedDomain = vi.fn();
const mockUpdateAllowedDomain = vi.fn();
const mockDeleteAllowedDomain = vi.fn();

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
		fetchAllowedDomains: (...args: unknown[]) => mockFetchAllowedDomains(...args),
		createAllowedDomain: (...args: unknown[]) => mockCreateAllowedDomain(...args),
		updateAllowedDomain: (...args: unknown[]) => mockUpdateAllowedDomain(...args),
		deleteAllowedDomain: (...args: unknown[]) => mockDeleteAllowedDomain(...args),
	};
});

const domains: AllowedDomain[] = [
	{
		domain: "example.com",
		defaultRole: 30,
		roleName: "Author",
		enabled: true,
		createdAt: "2026-01-01T00:00:00.000Z",
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

async function renderAllowedDomainsSettings() {
	return render(
		<QueryWrapper>
			<AllowedDomainsSettings />
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
	mockFetchAllowedDomains.mockResolvedValue([]);
	mockCreateAllowedDomain.mockResolvedValue(domains[0]);
	mockUpdateAllowedDomain.mockResolvedValue(domains[0]);
	mockDeleteAllowedDomain.mockResolvedValue(undefined);
});

describe("AllowedDomainsSettings", () => {
	it("shows the shared frame while the manifest loads", async () => {
		mockFetchManifest.mockReturnValue(new Promise(() => undefined));
		const screen = await renderAllowedDomainsSettings();

		await expect
			.element(screen.getByRole("heading", { name: "Self-Signup Domains", level: 1 }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Loading...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add Domain" }).query()).toBeNull();
	});

	it("shows the external-auth state without fetching domains", async () => {
		mockFetchManifest.mockResolvedValue({
			authMode: "cloudflare-access",
			collections: {},
			plugins: {},
			version: "1",
			hash: "",
		});
		const screen = await renderAllowedDomainsSettings();

		await expect.element(screen.getByRole("status")).toHaveTextContent("Self-Signup Domains");
		expect(mockFetchAllowedDomains).not.toHaveBeenCalled();
	});

	it("shows a domain load failure without management actions", async () => {
		mockFetchAllowedDomains.mockRejectedValue(new Error("Domain service unavailable"));
		const screen = await renderAllowedDomainsSettings();

		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Failed to load allowed domains");
		await expect.element(screen.getByRole("alert")).toHaveTextContent("Domain service unavailable");
		expect(screen.getByRole("button", { name: "Add Domain" }).query()).toBeNull();
	});

	it("shows an empty state and opens the add form", async () => {
		const screen = await renderAllowedDomainsSettings();

		await expect
			.element(screen.getByText("No domains configured. Users must be invited individually."))
			.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));
		await expect
			.element(screen.getByRole("textbox", { name: "Domain", exact: true }))
			.toBeInTheDocument();
		await expect.element(screen.getByLabelText("Default Role")).toBeInTheDocument();
	});

	it("adds a normalized domain with the selected default role", async () => {
		const screen = await renderAllowedDomainsSettings();
		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));
		await screen.getByRole("textbox", { name: "Domain", exact: true }).fill("  EXAMPLE.COM  ");
		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));

		await vi.waitFor(() => {
			expect(mockCreateAllowedDomain.mock.calls[0]![0]).toEqual({
				domain: "example.com",
				defaultRole: 30,
			});
		});
		await expect.element(screen.getByText("Domain added successfully")).toBeInTheDocument();
	});

	it("reports a failed domain addition", async () => {
		mockCreateAllowedDomain.mockRejectedValue(new Error("Domain is already allowed"));
		const screen = await renderAllowedDomainsSettings();
		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));
		await screen.getByRole("textbox", { name: "Domain", exact: true }).fill("example.com");
		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));

		await expect.element(screen.getByText("Failed to add domain")).toBeInTheDocument();
		await expect.element(screen.getByText("Domain is already allowed")).toBeInTheDocument();
	});

	it("updates a domain immediately when its switch changes", async () => {
		mockFetchAllowedDomains.mockResolvedValue(domains);
		const screen = await renderAllowedDomainsSettings();
		await expect.element(screen.getByText("example.com")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("switch", { name: "example.com" }));
		expect(mockUpdateAllowedDomain).toHaveBeenCalledWith("example.com", { enabled: false });
	});

	it("updates the default role from the edit dialog", async () => {
		mockFetchAllowedDomains.mockResolvedValue(domains);
		const screen = await renderAllowedDomainsSettings();
		await expect.element(screen.getByText("example.com")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Edit example.com" }));
		await expect.element(screen.getByRole("heading", { name: "Edit Domain" })).toBeInTheDocument();
		const roleSelect = screen.getByLabelText("Default Role").element() as HTMLButtonElement;
		roleSelect.click();
		await expect.element(screen.getByRole("option", { name: "Editor" })).toBeVisible();
		(screen.getByRole("option", { name: "Editor" }).element() as HTMLElement).click();

		await vi.waitFor(() => {
			expect(mockUpdateAllowedDomain).toHaveBeenCalledWith("example.com", { defaultRole: 40 });
		});
	});

	it("requires confirmation before deleting a domain", async () => {
		mockFetchAllowedDomains.mockResolvedValue(domains);
		const screen = await renderAllowedDomainsSettings();
		await expect.element(screen.getByText("example.com")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Delete example.com" }));
		await expect
			.element(screen.getByRole("heading", { name: "Remove Domain?" }))
			.toBeInTheDocument();
		expect(mockDeleteAllowedDomain).not.toHaveBeenCalled();
		const confirmButton = screen
			.getByRole("button", { name: "Remove Domain" })
			.element() as HTMLButtonElement;
		confirmButton.click();

		await vi.waitFor(() => {
			expect(mockDeleteAllowedDomain.mock.calls[0]![0]).toBe("example.com");
		});
	});

	it("keeps the delete dialog open and shows mutation errors", async () => {
		mockFetchAllowedDomains.mockResolvedValue(domains);
		mockDeleteAllowedDomain.mockRejectedValue(new Error("Domain is still in use"));
		const screen = await renderAllowedDomainsSettings();
		await expect.element(screen.getByText("example.com")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Delete example.com" }));
		const confirmButton = screen
			.getByRole("button", { name: "Remove Domain" })
			.element() as HTMLButtonElement;
		confirmButton.click();

		await expect.element(screen.getByRole("alert")).toHaveTextContent("Domain is still in use");
		await expect
			.element(screen.getByRole("heading", { name: "Remove Domain?" }))
			.toBeInTheDocument();
	});
});
