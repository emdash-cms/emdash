import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { PluginInfo, AdminManifest } from "../../src/lib/api";
import type { PluginUpdateInfo } from "../../src/lib/api/marketplace";
import { render } from "../utils/render.tsx";

// Mock router
vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, params, ...props }: any) => {
			let href = String(to ?? "");
			if (params && typeof params === "object") {
				for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
					const stringified =
						value == null
							? ""
							: typeof value === "string" || typeof value === "number"
								? String(value)
								: "";
					if (key === "_splat") {
						href = href.replace("$", stringified);
					} else {
						href = href.replace(`$${key}`, stringified);
					}
				}
			}
			return (
				<a href={href} {...props}>
					{children}
				</a>
			);
		},
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
		hasSettings: false,
		...overrides,
	};
}

function makeManifest(overrides: Partial<AdminManifest> = {}): AdminManifest {
	return {
		version: "1.0.0",
		hash: "abc",
		collections: {},
		plugins: {},
		taxonomies: [],
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

	it("pages link shown only for enabled plugins with admin pages", async () => {
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Audit Log")).toBeInTheDocument();
		const pagesLinks = screen.getByRole("link", { name: "Plugin pages" }).all();
		expect(pagesLinks.length).toBe(1);
	});

	it("pages link points to the plugin root, not a /settings sub-path", async () => {
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Audit Log")).toBeInTheDocument();
		const pagesLink = screen.getByRole("link", { name: "Plugin pages" });
		await expect.element(pagesLink).toBeInTheDocument();
		const anchor = pagesLink.element() as HTMLAnchorElement;
		// Plugins are not required to expose a `/settings` sub-page; the pages
		// icon should land on the plugin's primary admin page.
		expect(anchor.getAttribute("href")).toMatch(/^\/plugins\/audit-log\/?$/);
	});

	it("settings gear shown only for enabled plugins with a settings schema", async () => {
		mockFetchPlugins.mockResolvedValue([
			makePlugin({ id: "with-settings", name: "With Settings", hasSettings: true }),
			makePlugin({ id: "no-settings", name: "No Settings", hasSettings: false }),
			makePlugin({
				id: "disabled-settings",
				name: "Disabled Settings",
				hasSettings: true,
				enabled: false,
				status: "inactive",
			}),
		]);
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);
		await expect.element(screen.getByText("With Settings")).toBeInTheDocument();
		const settingsLinks = screen.getByRole("link", { name: "Settings" }).all();
		expect(settingsLinks.length).toBe(1);
		const anchor = settingsLinks[0]!.element() as HTMLAnchorElement;
		expect(anchor.getAttribute("href")).toBe("/plugins-manager/with-settings/settings");
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

	it("confirms marketplace capability changes with the server contract field", async () => {
		mockFetchPlugins.mockResolvedValue([
			makePlugin({
				id: "mp-plugin",
				name: "MP Plugin",
				source: "marketplace",
				version: "1.0.0",
			}),
		]);
		mockCheckPluginUpdates.mockResolvedValue([
			{
				pluginId: "mp-plugin",
				installed: "1.0.0",
				latest: "2.0.0",
				hasCapabilityChanges: true,
			},
		]);
		const screen = await render(
			<Wrapper>
				<PluginManager />
			</Wrapper>,
		);

		await screen.getByText("Check for updates").click();
		const updateButton = screen.getByText("Update to v2.0.0");
		await expect.element(updateButton).toBeInTheDocument();
		await updateButton.click();
		await screen.getByText("Accept & Update").click();

		await vi.waitFor(() => {
			expect(mockUpdateMarketplacePlugin).toHaveBeenCalledWith("mp-plugin", {
				confirmCapabilityChanges: true,
				confirmMcpTools: false,
			});
		});
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
