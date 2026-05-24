import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { MarketplacePluginDetail as PluginDetailType } from "../../src/lib/api/marketplace";
import { render } from "../utils/render.tsx";

const INSTALL_RE = /Install/;

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

const mockFetchMarketplacePlugin = vi.fn<() => Promise<PluginDetailType>>();
const mockInstallMarketplacePlugin = vi.fn<() => Promise<void>>();

vi.mock("../../src/lib/api/marketplace", async () => {
	const actual = await vi.importActual("../../src/lib/api/marketplace");
	return {
		...actual,
		fetchMarketplacePlugin: (...args: unknown[]) => mockFetchMarketplacePlugin(...(args as [])),
		installMarketplacePlugin: (...args: unknown[]) => mockInstallMarketplacePlugin(...(args as [])),
	};
});

// Import after mocks
const { MarketplacePluginDetail } = await import("../../src/components/MarketplacePluginDetail");

function makePluginDetail(overrides: Partial<PluginDetailType> = {}): PluginDetailType {
	return {
		id: "seo-helper",
		name: "SEO Helper",
		description: "Improve your SEO with automatic meta tags",
		author: { name: "Acme Inc", verified: true },
		capabilities: ["read:content", "write:content"],
		keywords: ["seo", "meta", "optimization"],
		installCount: 5200,
		license: "MIT",
		repositoryUrl: "https://github.com/acme/seo-helper",
		homepageUrl: "https://seo-helper.example.com",
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-02-01T00:00:00Z",
		latestVersion: {
			version: "2.1.0",
			minEmDashVersion: "0.8.0",
			bundleSize: 15360,
			readme: "# SEO Helper\n\nThis plugin helps with SEO.",
			audit: { verdict: "pass", riskScore: 5 },
			publishedAt: "2025-02-01T00:00:00Z",
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

describe("MarketplacePluginDetail", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchMarketplacePlugin.mockResolvedValue(makePluginDetail());
		mockInstallMarketplacePlugin.mockResolvedValue(undefined);
	});

	it("displays plugin name and description", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		// Name appears in header h1 and also in rendered README h1 — use first()
		await expect
			.element(screen.getByRole("heading", { name: "SEO Helper" }).first())
			.toBeInTheDocument();
		await expect
			.element(screen.getByText("Improve your SEO with automatic meta tags"))
			.toBeInTheDocument();
	});

	it("shows author name with verified badge", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Acme Inc")).toBeInTheDocument();
	});

	it("shows version number", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		// Wait for data to load — version appears in both header and sidebar
		await expect.element(screen.getByText("Acme Inc")).toBeInTheDocument();
		await expect.element(screen.getByText("v2.1.0").first()).toBeInTheDocument();
	});

	it("displays install count", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("5,200 installs")).toBeInTheDocument();
	});

	it("shows audit badge", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		// Wait for data to load, then check audit badge (appears in stats bar and sidebar)
		await expect.element(screen.getByText("Acme Inc")).toBeInTheDocument();
		await expect.element(screen.getByText("Pass").first()).toBeInTheDocument();
	});

	it("shows license", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("MIT")).toBeInTheDocument();
	});

	it("shows source and website links", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Source")).toBeInTheDocument();
		await expect.element(screen.getByText("Website")).toBeInTheDocument();
	});

	it("renders README content", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		// The markdown renderer should convert "# SEO Helper" and the paragraph
		await expect.element(screen.getByText("This plugin helps with SEO.")).toBeInTheDocument();
	});

	it("shows permissions sidebar", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Permissions")).toBeInTheDocument();
		await expect.element(screen.getByText("Read your content")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Create, update, and delete content"))
			.toBeInTheDocument();
	});

	it("shows keywords", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Keywords")).toBeInTheDocument();
		// "seo" appears in multiple places (name, description, keyword) — use exact match
		await expect.element(screen.getByText("seo", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("meta", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("optimization")).toBeInTheDocument();
	});

	it("shows audit summary with risk score", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Security Audit")).toBeInTheDocument();
		await expect.element(screen.getByText("Risk score: 5/100")).toBeInTheDocument();
	});

	it("shows version info with min emdash version", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Version")).toBeInTheDocument();
		await expect.element(screen.getByText("Requires EmDash 0.8.0")).toBeInTheDocument();
	});

	it("shows bundle size", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		// 15360 bytes = 15.0 KB
		await expect.element(screen.getByText("15.0 KB")).toBeInTheDocument();
	});

	it("shows Install button for non-installed plugin", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByRole("button", { name: INSTALL_RE })).toBeInTheDocument();
	});

	it("shows Installed badge for installed plugin", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail
					pluginId="seo-helper"
					installedPluginIds={new Set(["seo-helper"])}
				/>
			</Wrapper>,
		);
		await expect.element(screen.getByText("Installed")).toBeInTheDocument();
	});

	it("opens consent dialog on Install click", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		// Wait for data to load, then click Install button
		const installBtn = screen.getByRole("button", { name: INSTALL_RE });
		await expect.element(installBtn).toBeInTheDocument();
		await installBtn.click();
		// Consent dialog should appear
		await expect.element(screen.getByText("Plugin Permissions")).toBeInTheDocument();
		await expect
			.element(screen.getByText("SEO Helper requires the following permissions:"))
			.toBeInTheDocument();
	});

	it("shows error state when plugin fails to load", async () => {
		mockFetchMarketplacePlugin.mockRejectedValue(new Error("Plugin not found"));
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="nonexistent" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Failed to load plugin")).toBeInTheDocument();
		await expect.element(screen.getByText("Plugin not found")).toBeInTheDocument();
		// "Back to marketplace" appears multiple times (header + error) — just check one
		const backLinks = screen.getByText("Back to marketplace").all();
		expect(backLinks.length).toBeGreaterThanOrEqual(1);
	});

	it("shows 'No detailed description' when no README", async () => {
		mockFetchMarketplacePlugin.mockResolvedValue(
			makePluginDetail({
				latestVersion: {
					version: "1.0.0",
					bundleSize: 0,
					publishedAt: "2025-01-01T00:00:00Z",
				},
			}),
		);
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect
			.element(screen.getByText("No detailed description available."))
			.toBeInTheDocument();
	});

	it("shows 'no special permissions' when capabilities empty", async () => {
		mockFetchMarketplacePlugin.mockResolvedValue(makePluginDetail({ capabilities: [] }));
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect
			.element(screen.getByText("This plugin requires no special permissions."))
			.toBeInTheDocument();
	});

	it("renders screenshots when present", async () => {
		mockFetchMarketplacePlugin.mockResolvedValue(
			makePluginDetail({
				latestVersion: {
					version: "2.1.0",
					bundleSize: 15360,
					screenshotUrls: [
						"https://example.com/screenshot1.png",
						"https://example.com/screenshot2.png",
					],
					audit: { verdict: "pass", riskScore: 5 },
					publishedAt: "2025-02-01T00:00:00Z",
				},
			}),
		);
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Screenshots")).toBeInTheDocument();
		// Two screenshot images
		const imgs = screen.getByRole("img").all();
		const screenshotImgs = imgs.filter((img) =>
			img.element().getAttribute("alt")?.startsWith("Screenshot"),
		);
		expect(screenshotImgs.length).toBe(2);
	});

	it("has back link to marketplace", async () => {
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Back to marketplace")).toBeInTheDocument();
	});

	it("shows plugin avatar when no icon URL", async () => {
		mockFetchMarketplacePlugin.mockResolvedValue(makePluginDetail({ iconUrl: undefined }));
		const screen = await render(
			<Wrapper>
				<MarketplacePluginDetail pluginId="seo-helper" />
			</Wrapper>,
		);
		// First letter of "SEO Helper" is "S" — use exact match
		await expect.element(screen.getByText("S", { exact: true })).toBeInTheDocument();
	});

	describe("XSS prevention in README rendering", () => {
		async function renderWithReadme(readme: string) {
			mockFetchMarketplacePlugin.mockResolvedValue(
				makePluginDetail({
					latestVersion: {
						version: "1.0.0",
						bundleSize: 0,
						readme,
						audit: { verdict: "pass", riskScore: 0 },
						publishedAt: "2025-01-01T00:00:00Z",
					},
				}),
			);
			const screen = await render(
				<Wrapper>
					<MarketplacePluginDetail pluginId="seo-helper" />
				</Wrapper>,
			);
			// Wait for data to load
			await expect.element(screen.getByText("Acme Inc")).toBeInTheDocument();
			return screen;
		}

		it("strips img tags with onerror handlers from link text", async () => {
			const screen = await renderWithReadme(
				"[<img src=x onerror=alert(document.cookie)>](https://example.com)",
			);
			// The prose div contains the rendered README markdown
			const prose = screen.container.querySelector(".prose")!;
			// No img element should exist in the rendered output
			expect(prose.querySelectorAll("img[onerror]").length).toBe(0);
			// The onerror text should be escaped (visible as text), not as an attribute
			expect(prose.querySelectorAll("[onerror]").length).toBe(0);
		});

		it("strips attribute breakout via quotes in link text", async () => {
			const screen = await renderWithReadme('[a" onmouseover="alert(1)](https://example.com)');
			// The prose div contains the rendered README markdown
			const prose = screen.container.querySelector(".prose")!;
			// No element should have an onmouseover attribute
			expect(prose.querySelectorAll("[onmouseover]").length).toBe(0);
		});

		it("strips raw script tags from README", async () => {
			const screen = await renderWithReadme("Hello\n\n<script>alert('xss')</script>\n\nWorld");
			expect(screen.container.querySelectorAll("script").length).toBe(0);
			expect(screen.container.innerHTML).not.toContain("<script");
		});

		it("strips event handlers from raw HTML in README", async () => {
			const screen = await renderWithReadme('<div onload="alert(1)">test</div>');
			expect(screen.container.innerHTML).not.toContain("onload");
		});

		it("renders safe markdown content correctly", async () => {
			const screen = await renderWithReadme(
				"# Title\n\nA paragraph with **bold** and [a link](https://example.com).",
			);
			// The link text should be rendered as plain text within an anchor
			await expect.element(screen.getByText("a link")).toBeInTheDocument();
			const link = screen.container.querySelector('a[href="https://example.com"]');
			expect(link).not.toBeNull();
			expect(link?.getAttribute("target")).toBe("_blank");
			expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
		});
	});
});
