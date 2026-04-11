import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { userEvent } from "@vitest/browser/context";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "../utils/render.js";

import { AllowedDomainsSettings } from "../../../src/components/settings/AllowedDomainsSettings";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

const EXTERNAL_PROVIDER_MSG_REGEX = /User access is managed by an external provider/;
const NO_DOMAINS_CONFIGURED_REGEX = /No domains configured/;

const mockFetchManifest = vi.fn();
const mockFetchAllowedDomains = vi.fn();
const mockCreateAllowedDomain = vi.fn();
const mockUpdateAllowedDomain = vi.fn();
const mockDeleteAllowedDomain = vi.fn();

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

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
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
	mockCreateAllowedDomain.mockResolvedValue({});
	mockUpdateAllowedDomain.mockResolvedValue({});
	mockDeleteAllowedDomain.mockResolvedValue({});
});

describe("AllowedDomainsSettings", () => {
	it("shows domain management when authMode is passkey", async () => {
		const screen = await render(
			<QueryWrapper>
				<AllowedDomainsSettings />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Self-Signup Domains")).toBeInTheDocument();
		await expect.element(screen.getByText("Allowed Domains")).toBeInTheDocument();
	});

	it("shows info message when authMode is not passkey", async () => {
		mockFetchManifest.mockResolvedValue({
			authMode: "cloudflare-access",
			collections: {},
			plugins: {},
			version: "1",
			hash: "",
		});
		const screen = await render(
			<QueryWrapper>
				<AllowedDomainsSettings />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText(EXTERNAL_PROVIDER_MSG_REGEX)).toBeInTheDocument();
	});

	it("empty state shows 'No domains configured'", async () => {
		const screen = await render(
			<QueryWrapper>
				<AllowedDomainsSettings />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText(NO_DOMAINS_CONFIGURED_REGEX)).toBeInTheDocument();
	});

	it("add domain form: toggles open, has domain input and role select", async () => {
		const screen = await render(
			<QueryWrapper>
				<AllowedDomainsSettings />
			</QueryWrapper>,
		);
		// Wait for data to load
		await expect.element(screen.getByText("Add Domain")).toBeInTheDocument();
		// Click Add Domain to show the form
		const addButton = screen.getByText("Add Domain").element().closest("button")!;
		await userEvent.click(addButton);
		await expect.element(screen.getByLabelText("Domain")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Default Role")).toBeInTheDocument();
	});

	it("add domain: submitting calls createAllowedDomain", async () => {
		mockCreateAllowedDomain.mockResolvedValue({
			domain: "example.com",
			defaultRole: 30,
			roleName: "Author",
			enabled: true,
			createdAt: "2025-01-01T00:00:00Z",
		});
		const screen = await render(
			<QueryWrapper>
				<AllowedDomainsSettings />
			</QueryWrapper>,
		);
		// Open add form
		await expect.element(screen.getByText("Add Domain")).toBeInTheDocument();
		const addButton = screen.getByText("Add Domain").element().closest("button")!;
		await userEvent.click(addButton);
		// Fill in domain
		const domainInput = screen.getByLabelText("Domain");
		await userEvent.type(domainInput, "example.com");
		// The form submit button also says "Add Domain" — click it
		await expect.element(screen.getByText("Add Domain")).toBeInTheDocument();
		const submitButton = screen.getByText("Add Domain").element().closest("button")!;
		await userEvent.click(submitButton);
		await vi.waitFor(() => {
			expect(mockCreateAllowedDomain).toHaveBeenCalled();
		});
		expect(mockCreateAllowedDomain.mock.calls[0]![0]).toEqual({
			domain: "example.com",
			defaultRole: 30,
		});
	});

	it("delete domain: confirmation dialog, confirm calls deleteAllowedDomain", async () => {
		mockFetchAllowedDomains.mockResolvedValue([
			{
				domain: "test.com",
				defaultRole: 30,
				roleName: "Author",
				enabled: true,
				createdAt: "2025-01-01T00:00:00Z",
			},
		]);
		mockDeleteAllowedDomain.mockResolvedValue({});
		const screen = await render(
			<QueryWrapper>
				<AllowedDomainsSettings />
			</QueryWrapper>,
		);
		// Wait for the domain to appear
		await expect.element(screen.getByText("test.com")).toBeInTheDocument();
		// Click delete button
		const deleteButton = screen.getByLabelText("Delete test.com");
		await deleteButton.click();
		// Confirmation dialog should appear
		await expect.element(screen.getByText("Remove Domain?")).toBeInTheDocument();
		// Confirm deletion - Base UI overlays block pointer events, so click the element directly
		const confirmButton = screen
			.getByRole("button", { name: "Remove Domain" })
			.element() as HTMLButtonElement;
		confirmButton.click();
		await vi.waitFor(() => {
			expect(mockDeleteAllowedDomain).toHaveBeenCalled();
		});
		expect(mockDeleteAllowedDomain.mock.calls[0]![0]).toBe("test.com");
	});

	it("toggle enable/disable calls updateAllowedDomain", async () => {
		mockFetchAllowedDomains.mockResolvedValue([
			{
				domain: "test.com",
				defaultRole: 30,
				roleName: "Author",
				enabled: true,
				createdAt: "2025-01-01T00:00:00Z",
			},
		]);
		mockUpdateAllowedDomain.mockResolvedValue({});
		const screen = await render(
			<QueryWrapper>
				<AllowedDomainsSettings />
			</QueryWrapper>,
		);
		// Wait for the domain to appear
		await expect.element(screen.getByText("test.com")).toBeInTheDocument();
		// Find and click the switch toggle
		const switchEl = screen.getByRole("switch");
		await switchEl.click();
		expect(mockUpdateAllowedDomain).toHaveBeenCalledWith("test.com", { enabled: false });
	});
});
