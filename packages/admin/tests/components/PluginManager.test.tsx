import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { PluginInfo, AdminManifest } from "../../src/lib/api";
import type { PluginUpdateInfo } from "../../src/lib/api/marketplace";
import { render } from "../utils/render.js";

// Mock router
vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
		useNavigate: () => vi.fn(),
	};
});

const mockFetchPlugins = vi.fn<() => Promise<PluginInfo[]>>();
const mockEnablePlugin = vi.fn();
const mockDisablePlugin = vi.fn();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchPlugins: (...args: unknown[]) => mockFetchPlugins(...(args as [])),
		enablePlugin: (...args: unknown[]) => mockEnablePlugin(...(args as [])),
		disablePlugin: (...args: unknown[]) => mockDisablePlugin(...(args as [])),
	};
});

const mockCheckPluginUpdates = vi.fn<() => Promise<PluginUpdateInfo[]>>();
const mockUpdateMarketplacePlugin = vi.fn<() => Promise<void>>();
const mockUninstallMarketplacePlugin = vi.fn<() => Promise<void>>();

vi.mock("../../src/lib/api/marketplace", async () => {
	const actual = await vi.importActual("../../src/lib/api/marketplace");
	return {
		...actual,
		checkPluginUpdates: (...args: unknown[]) => mockCheckPluginUpdates(...(args as [])),
		updateMarketplacePlugin: (...args: unknown[]) => mockUpdateMarketplacePlugin(...(args as [])),
		uninstallMarketplacePlugin: (...args: unknown[]) =>
			mockUninstallMarketplacePlugin(...(args as [])),
	};
});

// Import after mocks
const { PluginManager } = await import("../../src/components/PluginManager");

function makePlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
	return {
		id: "test-plugin",
		name: "Test Plugin",
		version: "1.0.0",
		enabled: true,
		status: "active",
		capabilities: ["hooks"],
		hasAdminPages: false,
		hasDashboardWidgets: false,
		hasHooks: true,
		...overrides,
	};
}

function makeManifest(overrides: Partial<AdminManifest> = {}): AdminManifest {
	return {
		version: "1.0.0",
		hash: "abc",
		collections: {},
		plugins: {},
		authMode: "passkey",
		...overrides,
	};
}

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={qc}>
			<Toasty>{children}</Toasty>
		</QueryClientProvider>
	);
}

describe("PluginManager", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchPlugins.mockResolvedValue([
			makePlugin({
				id: "audit-log",
				name: "Audit Log",
				version: "1.0.0",
				enabled: true,
				hasAdminPages: true,
				capabilities: ["hooks", "pages"],
			}),
			makePlugin({
				id: "seo",
				name: "SEO Helper",
				version: "2.0.0",
				enabled: false,
				status: "inactive",
				hasAdminPages: false,
				capabilities: ["hooks"],
			}),
		]);
		mockEnablePlugin.mockResolvedValue({});
		mockDisablePlugin.mockResolvedValue({});
		mockCheckPluginUpdates.mockResolvedValue([]);
		mockUpdateMarketplacePlugin.mockResolvedValue(undefined);
		mockUninstallMarketplacePlugin.mockResolvedValue(undefined);
	});

	it("displays plugin list with names and versions", async () => {
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Audit Log")).toBeInTheDocument();
		await expect.element(screen.getByText("v1.0.0")).toBeInTheDocument();
		await expect.element(screen.getByText("SEO Helper")).toBeInTheDocument();
		await expect.element(screen.getByText("v2.0.0")).toBeInTheDocument();
	});

	it("enabled plugins show toggle in on state", async () => {
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Audit Log")).toBeInTheDocument();
		const enableToggle = screen.getByRole("switch", { name: "Disable plugin" });
		await expect.element(enableToggle).toBeInTheDocument();
	});

	it("disabled plugins show toggle in off state", async () => {
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("SEO Helper")).toBeInTheDocument();
		const disableToggle = screen.getByRole("switch", { name: "Enable plugin" });
		await expect.element(disableToggle).toBeInTheDocument();
	});

	it("settings link shown only for enabled plugins with admin pages", async () => {
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Audit Log")).toBeInTheDocument();
		const settingsButtons = screen.getByRole("button", { name: "Settings" }).all();
		expect(settingsButtons.length).toBe(1);
	});

	it("expand/collapse shows plugin details", async () => {
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Audit Log")).toBeInTheDocument();
		const expandButtons = screen.getByRole("button", { name: "Expand details" }).all();
		expect(expandButtons.length).toBeGreaterThan(0);
		await expandButtons[0]!.click();
		await expect.element(screen.getByText("Capabilities")).toBeInTheDocument();
		await vi.waitFor(() => {
			const badges = document.querySelectorAll(".inline-flex.items-center.rounded-md.bg-kumo-tint");
			expect(badges.length).toBeGreaterThanOrEqual(2);
		});
	});

	it("empty state when no plugins", async () => {
		mockFetchPlugins.mockResolvedValue([]);
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("No plugins configured")).toBeInTheDocument();
		await expect
			.element(
				screen.getByText("Add plugins to your astro.config.mjs to extend EmDash functionality."),
			)
			.toBeInTheDocument();
	});

	// -----------------------------------------------------------------------
	// Marketplace features
	// -----------------------------------------------------------------------

	it("shows Marketplace link when manifest has marketplace URL", async () => {
		const screen = await render(
			<Wrapper>
				<PluginManager
					manifest={makeManifest({ marketplace: "https://marketplace.emdashcms.com" })}
				/>
			</Wrapper>,
		);
		await expect.element(screen.getByText("Audit Log")).toBeInTheDocument();
		await expect.element(screen.getByText("Marketplace")).toBeInTheDocument();
	});

	it("hides Marketplace link when no marketplace configured", async () => {
		const screen = await render(
			<Wrapper>
				<PluginManager manifest={makeManifest()} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Audit Log")).toBeInTheDocument();
		const marketplaceLink = screen.getByText("Marketplace");
		await expect.element(marketplaceLink).not.toBeInTheDocument();
	});

	it("shows Marketplace badge on marketplace-installed plugins", async () => {
		mockFetchPlugins.mockResolvedValue([
			makePlugin({
				id: "mp-plugin",
				name: "Marketplace Plugin",
				source: "marketplace",
				marketplaceVersion: "1.2.0",
			}),
		]);
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Marketplace Plugin")).toBeInTheDocument();
		// Look for the "Marketplace" badge
		const badges = screen.getByText("Marketplace").all();
		// At least one should be the source badge on the card (not the nav link)
		expect(badges.length).toBeGreaterThanOrEqual(1);
	});

	it("shows 'Check for updates' button when marketplace plugins exist", async () => {
		mockFetchPlugins.mockResolvedValue([
			makePlugin({
				id: "mp-plugin",
				name: "MP Plugin",
				source: "marketplace",
			}),
		]);
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Check for updates")).toBeInTheDocument();
	});

	it("hides 'Check for updates' button when no marketplace plugins", async () => {
		mockFetchPlugins.mockResolvedValue([
			makePlugin({ id: "config-plugin", name: "Config Plugin", source: "config" }),
		]);
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Config Plugin")).toBeInTheDocument();
		const checkBtn = screen.getByText("Check for updates");
		await expect.element(checkBtn).not.toBeInTheDocument();
	});

	it("shows marketplace source in expanded details", async () => {
		mockFetchPlugins.mockResolvedValue([
			makePlugin({
				id: "mp-plugin",
				name: "MP Plugin",
				source: "marketplace",
				marketplaceVersion: "1.5.0",
			}),
		]);
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("MP Plugin")).toBeInTheDocument();
		// Expand
		const expandBtn = screen.getByRole("button", { name: "Expand details" });
		await expandBtn.click();
		await expect
			.element(screen.getByText("Installed from marketplace (v1.5.0)"))
			.toBeInTheDocument();
	});

	it("shows uninstall button for marketplace plugins in expanded details", async () => {
		mockFetchPlugins.mockResolvedValue([
			makePlugin({
				id: "mp-plugin",
				name: "MP Plugin",
				source: "marketplace",
			}),
		]);
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("MP Plugin")).toBeInTheDocument();
		// Expand
		const expandBtn = screen.getByRole("button", { name: "Expand details" });
		await expandBtn.click();
		await expect.element(screen.getByText("Uninstall")).toBeInTheDocument();
	});

	it("uninstall button opens confirmation dialog", async () => {
		mockFetchPlugins.mockResolvedValue([
			makePlugin({
				id: "mp-plugin",
				name: "MP Plugin",
				source: "marketplace",
			}),
		]);
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("MP Plugin")).toBeInTheDocument();
		const expandBtn = screen.getByRole("button", { name: "Expand details" });
		await expandBtn.click();
		await screen.getByText("Uninstall").click();
		// Confirm dialog
		await expect.element(screen.getByText("Uninstall MP Plugin?")).toBeInTheDocument();
		await expect
			.element(screen.getByText("This will remove the plugin and its bundle from your site."))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Also delete plugin storage data")).toBeInTheDocument();
	});

	it("empty state mentions marketplace when configured", async () => {
		mockFetchPlugins.mockResolvedValue([]);
		const screen = await render(
			<Wrapper>
				<PluginManager
					manifest={makeManifest({ marketplace: "https://marketplace.emdashcms.com" })}
				/>
			</Wrapper>,
		);
		await expect.element(screen.getByText("No plugins configured")).toBeInTheDocument();
		// The empty state links to the marketplace
		await expect.element(screen.getByText("marketplace", { exact: true })).toBeInTheDocument();
	});
});
