import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
	MarketplaceSearchResult,
	MarketplacePluginSummary,
} from "../../src/lib/api/marketplace";
import { render } from "../utils/render.tsx";

// Mock router
const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, params, ...props }: any) => {
			const href = params?.pluginId ? to.replace("$pluginId", params.pluginId) : to;
			return (
				<a href={href} {...props}>
					{children}
				</a>
			);
		},
		useNavigate: () => mockNavigate,
	};
});

const mockSearchMarketplace = vi.fn<() => Promise<MarketplaceSearchResult>>();

vi.mock("../../src/lib/api/marketplace", async () => {
	const actual = await vi.importActual("../../src/lib/api/marketplace");
	return {
		...actual,
		searchMarketplace: (...args: unknown[]) => mockSearchMarketplace(...(args as [])),
	};
});

// Import after mocks
const { MarketplaceBrowse } = await import("../../src/components/MarketplaceBrowse");

function makePlugin(overrides: Partial<MarketplacePluginSummary> = {}): MarketplacePluginSummary {
	return {
		id: "test-plugin",
		name: "Test Plugin",
		description: "A test plugin for testing",
		author: { name: "Test Author", verified: false },
		capabilities: ["read:content"],
		installCount: 1234,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-02-01T00:00:00Z",
		latestVersion: {
			version: "1.0.0",
			audit: { verdict: "pass", riskScore: 10 },
		},
		...overrides,
	};
}

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("MarketplaceBrowse", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSearchMarketplace.mockResolvedValue({
			items: [
				makePlugin({
					id: "seo-helper",
					name: "SEO Helper",
					description: "Improve your SEO",
					author: { name: "Acme Inc", verified: true },
					installCount: 5200,
					capabilities: ["read:content", "write:content"],
					latestVersion: {
						version: "1.2.3",
						audit: { verdict: "pass", riskScore: 10 },
					},
				}),
				makePlugin({
					id: "analytics",
					name: "Analytics",
					description: "Track page views",
					author: { name: "DataCorp", verified: false },
					installCount: 890,
					capabilities: ["network:fetch"],
					latestVersion: {
						version: "2.0.0",
						audit: { verdict: "warn", riskScore: 45 },
					},
				}),
			],
		});
	});

	it("renders marketplace header", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Marketplace")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Browse and install plugins to extend your site."))
			.toBeInTheDocument();
	});

	it("displays plugin cards with names and authors", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		await expect.element(screen.getByText("SEO Helper")).toBeInTheDocument();
		await expect.element(screen.getByText("Acme Inc")).toBeInTheDocument();
		await expect.element(screen.getByText("Analytics")).toBeInTheDocument();
		await expect.element(screen.getByText("DataCorp")).toBeInTheDocument();
	});

	it("shows plugin descriptions", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Improve your SEO")).toBeInTheDocument();
		await expect.element(screen.getByText("Track page views")).toBeInTheDocument();
	});

	it("formats install counts (K for thousands)", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		// 5200 → 5.2k
		await expect.element(screen.getByText("5.2k")).toBeInTheDocument();
		// 890 → 890
		await expect.element(screen.getByText("890")).toBeInTheDocument();
	});

	it("shows permission count", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		// SEO Helper has 2 capabilities
		await expect.element(screen.getByText("2 permissions")).toBeInTheDocument();
		// Analytics has 1 capability
		await expect.element(screen.getByText("1 permission")).toBeInTheDocument();
	});

	it("shows audit badges", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		// SEO Helper has "pass", Analytics has "warn"
		await expect.element(screen.getByText("Pass")).toBeInTheDocument();
		await expect.element(screen.getByText("Warn")).toBeInTheDocument();
	});

	it("shows 'Installed' badge for installed plugins", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse installedPluginIds={new Set(["seo-helper"])} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Installed")).toBeInTheDocument();
	});

	it("shows empty state when no results", async () => {
		mockSearchMarketplace.mockResolvedValue({ items: [] });
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		await expect.element(screen.getByText("No plugins found")).toBeInTheDocument();
	});

	it("shows error state with retry button", async () => {
		mockSearchMarketplace.mockRejectedValue(new Error("Network timeout"));
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Unable to reach marketplace")).toBeInTheDocument();
		await expect.element(screen.getByText("Network timeout")).toBeInTheDocument();
		await expect.element(screen.getByText("Retry")).toBeInTheDocument();
	});

	it("has search input", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		const searchInput = screen.getByPlaceholder("Search plugins...");
		await expect.element(searchInput).toBeInTheDocument();
	});

	it("has sort dropdown with options", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		const sortSelect = screen.getByRole("combobox", { name: "Sort plugins" });
		await expect.element(sortSelect).toBeInTheDocument();
	});

	it("plugin cards link to detail page", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		// Wait for cards to render
		await expect.element(screen.getByText("SEO Helper")).toBeInTheDocument();
		// The Link wraps the card, creating an <a> with the plugin detail path
		const links = screen.getByRole("link").all();
		const seoLink = links.find((l) => l.element().getAttribute("href")?.includes("seo-helper"));
		expect(seoLink).toBeDefined();
	});

	it("shows plugin avatar when no icon URL", async () => {
		mockSearchMarketplace.mockResolvedValue({
			items: [makePlugin({ id: "no-icon", name: "Zeta Plugin", iconUrl: undefined })],
		});
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		// The avatar shows the first letter — use exact match to avoid matching "Zeta Plugin"
		await expect.element(screen.getByText("Z", { exact: true })).toBeInTheDocument();
	});

	it("shows version numbers on cards", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		await expect.element(screen.getByText("v1.2.3")).toBeInTheDocument();
		await expect.element(screen.getByText("v2.0.0")).toBeInTheDocument();
	});

	it("has capability filter dropdown", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		const capabilitySelect = screen.getByRole("combobox", { name: "Filter by capability" });
		await expect.element(capabilitySelect).toBeInTheDocument();
		// Default option
		await expect.element(screen.getByText("All capabilities")).toBeInTheDocument();
	});

	it("installed badge navigates to plugin manager on click", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse installedPluginIds={new Set(["seo-helper"])} />
			</Wrapper>,
		);
		const badge = screen.getByText("Installed");
		await expect.element(badge).toBeInTheDocument();
		await badge.click();
		expect(mockNavigate).toHaveBeenCalledWith({ to: "/plugins-manager" });
	});

	it("shows 'Load more' button when there are more pages", async () => {
		mockSearchMarketplace.mockResolvedValue({
			items: [makePlugin({ id: "plugin-1", name: "Plugin One" })],
			nextCursor: "cursor-abc",
		});
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Load more")).toBeInTheDocument();
	});

	it("does not show 'Load more' when there are no more pages", async () => {
		mockSearchMarketplace.mockResolvedValue({
			items: [makePlugin({ id: "plugin-1", name: "Plugin One" })],
		});
		const screen = await render(
			<Wrapper>
				<MarketplaceBrowse />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Plugin One")).toBeInTheDocument();
		expect(screen.getByText("Load more").query()).toBeNull();
	});
});
