import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../../dist/styles.css";
import { AllowedDomainsSettings } from "../../../src/components/settings/AllowedDomainsSettings";
import { ApiResponseError, type AllowedDomain } from "../../../src/lib/api";
import { pressOutside } from "../../utils/mouse.ts";
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

	it("points at a missing or malformed domain when adding, and sends nothing", async () => {
		const screen = await renderAllowedDomainsSettings();
		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));
		const domain = screen.getByRole("textbox", { name: "Domain", exact: true });
		await expect.element(domain).toBeInTheDocument();
		expect(screen.getByText("Enter a domain.").query()).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));
		await expect.element(domain).toHaveAccessibleDescription("Enter a domain.");
		await expect.element(domain).toHaveAttribute("aria-invalid", "true");
		await expect.element(domain).toHaveFocus();

		await domain.fill("https://example.com");
		await userEvent.keyboard("{Enter}");
		await expect.element(domain).toHaveAccessibleDescription("Enter a domain such as example.com.");
		expect(mockCreateAllowedDomain).not.toHaveBeenCalled();

		await domain.fill("example.com");
		await expect.element(domain).not.toHaveAttribute("aria-invalid");
		await userEvent.keyboard("{Enter}");
		await vi.waitFor(() =>
			expect(mockCreateAllowedDomain.mock.calls[0]?.[0]).toEqual({
				domain: "example.com",
				defaultRole: 30,
			}),
		);
	});

	it("shows a domain already in the list on the domain field", async () => {
		mockCreateAllowedDomain.mockRejectedValue(
			new ApiResponseError(409, "CONFLICT", "Domain already exists"),
		);
		const screen = await renderAllowedDomainsSettings();
		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));
		const domain = screen.getByRole("textbox", { name: "Domain", exact: true });
		await domain.fill("example.com");
		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));

		const taken = "This domain is already in the list. Enter a different one.";
		await expect.element(domain).toHaveAccessibleDescription(taken);
		await expect.element(domain).toHaveFocus();
		expect(screen.getByText("Domain already exists").query()).toBeNull();
		expect(screen.getByText("Failed to add domain").query()).toBeNull();

		await domain.fill("example.org");
		await expect.element(domain).not.toHaveAccessibleDescription(taken);
	});

	it("reports a refused domain when the domain changed during the request", async () => {
		let rejectCreate!: (error: unknown) => void;
		mockCreateAllowedDomain.mockImplementation(
			() =>
				new Promise((_, reject) => {
					rejectCreate = reject;
				}),
		);
		const screen = await renderAllowedDomainsSettings();
		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));
		const domain = screen.getByRole("textbox", { name: "Domain", exact: true });
		await domain.fill("example.com");
		await userEvent.click(screen.getByRole("button", { name: "Add Domain" }));
		await expect.element(screen.getByRole("button", { name: "Adding..." })).toBeVisible();
		await domain.fill("example.org");
		rejectCreate(new ApiResponseError(409, "CONFLICT", "Domain already exists"));

		await expect.element(screen.getByText("Failed to add domain")).toBeInTheDocument();
		await expect.element(screen.getByText("Domain already exists")).toBeInTheDocument();
		await expect.element(domain).not.toHaveAttribute("aria-invalid");
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
		const dialog = screen.getByRole("dialog", { name: "Edit Domain" });
		await expect.element(dialog).toBeVisible();
		const save = dialog.getByRole("button", { name: "Save", exact: true });
		await expect.element(save).toBeDisabled();
		await chooseRole(screen, "Editor");
		expect(mockUpdateAllowedDomain).not.toHaveBeenCalled();

		await save.click();
		await vi.waitFor(() => {
			expect(mockUpdateAllowedDomain).toHaveBeenCalledWith("example.com", { defaultRole: 40 });
		});
		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(screen.getByText("Domain updated")).toBeInTheDocument();
	});

	it("reports a failed role change inside the edit dialog only, and holds it open while saving", async () => {
		mockFetchAllowedDomains.mockResolvedValue(domains);
		let reject: (error: Error) => void = () => {};
		mockUpdateAllowedDomain.mockImplementation(
			() =>
				new Promise((_resolve, rejectUpdate) => {
					reject = rejectUpdate;
				}),
		);
		const screen = await renderAllowedDomainsSettings();
		await userEvent.click(screen.getByRole("button", { name: "Edit example.com" }));
		const dialog = screen.getByRole("dialog", { name: "Edit Domain" });
		await chooseRole(screen, "Editor");
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect.element(dialog.getByRole("button", { name: "Saving..." })).toBeDisabled();

		await userEvent.keyboard("{Escape}");
		await expect.element(dialog).toBeVisible();

		reject(new Error("Role service unavailable"));
		await expect.element(dialog.getByRole("alert")).toHaveTextContent("Role service unavailable");
		expect(screen.getByText("Failed to update domain").query()).toBeNull();
	});

	it("keeps a changed role through a press outside, and closes untouched", async () => {
		mockFetchAllowedDomains.mockResolvedValue(domains);
		const screen = await renderAllowedDomainsSettings();
		await userEvent.click(screen.getByRole("button", { name: "Edit example.com" }));
		const dialog = screen.getByRole("dialog", { name: "Edit Domain" });
		await expect.element(dialog).toBeVisible();

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Edit example.com" }));
		await expect.element(dialog).toBeVisible();
		await chooseRole(screen, "Editor");
		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByRole("combobox")).toHaveTextContent("Editor");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		expect(mockUpdateAllowedDomain).not.toHaveBeenCalled();
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
		expect(screen.getByText("Failed to remove domain").query()).toBeNull();
	});
});

async function chooseRole(screen: Awaited<ReturnType<typeof render>>, role: string) {
	(screen.getByLabelText("Default Role").element() as HTMLButtonElement).click();
	await expect.element(screen.getByRole("option", { name: role })).toBeVisible();
	(screen.getByRole("option", { name: role }).element() as HTMLElement).click();
	await expect.element(screen.getByRole("option", { name: role })).not.toBeInTheDocument();
}
