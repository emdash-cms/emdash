/**
 * Lightweight mock marketplace server for e2e tests.
 *
 * Serves canned JSON responses for the endpoints the admin UI hits:
 *   - GET /api/v1/plugins       (search)
 *   - GET /api/v1/plugins/:id   (detail)
 *   - GET /api/v1/themes        (search)
 *   - GET /api/v1/themes/:id    (detail)
 *   - GET /health               (health check)
 *
 * Runs on a configurable port and returns deterministic fixture data.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

// Matches MarketplacePluginSummary from plugins/marketplace.ts
const PLUGINS = [
	{
		id: "seo-toolkit",
		name: "SEO Toolkit",
		description: "Comprehensive SEO tools for your EmDash site.",
		author: { name: "EmDash Labs", verified: true, avatarUrl: null },
		capabilities: ["read:content", "write:content"],
		keywords: ["seo", "meta", "sitemap"],
		installCount: 12400,
		hasIcon: false,
		iconUrl: "",
		createdAt: "2025-06-01T00:00:00Z",
		updatedAt: "2026-02-15T00:00:00Z",
		latestVersion: {
			version: "2.1.0",
			audit: { verdict: "pass", riskScore: 5 },
			imageAudit: null,
		},
	},
	{
		id: "analytics-dashboard",
		name: "Analytics Dashboard",
		description: "Track page views and visitor metrics.",
		author: { name: "DataCorp", verified: false, avatarUrl: null },
		capabilities: ["network:fetch"],
		keywords: ["analytics", "metrics"],
		installCount: 3200,
		hasIcon: false,
		iconUrl: "",
		createdAt: "2025-09-01T00:00:00Z",
		updatedAt: "2026-03-01T00:00:00Z",
		latestVersion: {
			version: "1.5.0",
			audit: { verdict: "warn", riskScore: 35 },
			imageAudit: null,
		},
	},
	{
		id: "social-sharing",
		name: "Social Sharing",
		description: "Add social share buttons to your content.",
		author: { name: "Community Plugins", verified: false, avatarUrl: null },
		capabilities: ["read:content"],
		keywords: ["social", "sharing"],
		installCount: 890,
		hasIcon: false,
		iconUrl: "",
		createdAt: "2026-01-10T00:00:00Z",
		updatedAt: "2026-03-10T00:00:00Z",
		latestVersion: {
			version: "1.0.2",
			audit: { verdict: "pass", riskScore: 8 },
			imageAudit: null,
		},
	},
];

// Matches MarketplacePluginDetail from plugins/marketplace.ts
const PLUGIN_DETAILS: Record<string, object> = {
	"seo-toolkit": {
		...PLUGINS[0],
		repositoryUrl: "https://github.com/emdash-labs/seo-toolkit",
		homepageUrl: "https://emdash-labs.dev/seo-toolkit",
		license: "MIT",
		latestVersion: {
			...PLUGINS[0]!.latestVersion,
			minEmDashVersion: null,
			bundleSize: 45000,
			checksum: "abc123",
			hasIcon: false,
			screenshotCount: 0,
			screenshotUrls: [],
			capabilities: ["read:content", "write:content"],
			status: "published",
			readme:
				"# SEO Toolkit\n\nA comprehensive SEO plugin for EmDash.\n\n## Features\n\n- Meta tag management\n- Open Graph support\n- Sitemap generation",
			changelog: "## 2.1.0\n- Added sitemap generation\n- Fixed Open Graph preview",
			publishedAt: "2026-02-15T00:00:00Z",
		},
		versions: [
			{ version: "2.1.0", publishedAt: "2026-02-15T00:00:00Z" },
			{ version: "2.0.0", publishedAt: "2025-12-01T00:00:00Z" },
			{ version: "1.0.0", publishedAt: "2025-06-01T00:00:00Z" },
		],
	},
	"analytics-dashboard": {
		...PLUGINS[1],
		repositoryUrl: "https://github.com/datacorp/analytics-dashboard",
		homepageUrl: null,
		license: "Apache-2.0",
		latestVersion: {
			...PLUGINS[1]!.latestVersion,
			minEmDashVersion: null,
			bundleSize: 32000,
			checksum: "def456",
			hasIcon: false,
			screenshotCount: 0,
			screenshotUrls: [],
			capabilities: ["network:fetch"],
			status: "published",
			readme: "# Analytics Dashboard\n\nTrack visitors with a simple dashboard.",
			changelog: "## 1.5.0\n- Improved chart rendering",
			publishedAt: "2026-03-01T00:00:00Z",
		},
		versions: [
			{ version: "1.5.0", publishedAt: "2026-03-01T00:00:00Z" },
			{ version: "1.0.0", publishedAt: "2025-09-01T00:00:00Z" },
		],
	},
	"social-sharing": {
		...PLUGINS[2],
		repositoryUrl: null,
		homepageUrl: null,
		license: "MIT",
		latestVersion: {
			...PLUGINS[2]!.latestVersion,
			minEmDashVersion: null,
			bundleSize: 12000,
			checksum: "ghi789",
			hasIcon: false,
			screenshotCount: 0,
			screenshotUrls: [],
			capabilities: ["read:content"],
			status: "published",
			readme: "# Social Sharing\n\nAdd share buttons to your posts.",
			changelog: "## 1.0.2\n- Bug fixes",
			publishedAt: "2026-03-10T00:00:00Z",
		},
		versions: [{ version: "1.0.2", publishedAt: "2026-03-10T00:00:00Z" }],
	},
};

// Matches MarketplaceThemeSummary from plugins/marketplace.ts
const THEMES = [
	{
		id: "minimal-blog",
		name: "Minimal Blog",
		description: "A clean, minimal blog theme.",
		author: { name: "EmDash Labs", verified: true, avatarUrl: null },
		keywords: ["blog", "minimal", "clean"],
		previewUrl: "https://demo.emdashcms.com/themes/minimal-blog",
		demoUrl: null,
		hasThumbnail: false,
		thumbnailUrl: null,
		createdAt: "2025-08-01T00:00:00Z",
		updatedAt: "2026-02-20T00:00:00Z",
	},
	{
		id: "portfolio-pro",
		name: "Portfolio Pro",
		description: "Showcase your work with style.",
		author: { name: "DesignStudio", verified: false, avatarUrl: null },
		keywords: ["portfolio", "gallery", "creative"],
		previewUrl: "https://demo.emdashcms.com/themes/portfolio-pro",
		demoUrl: null,
		hasThumbnail: false,
		thumbnailUrl: null,
		createdAt: "2025-11-15T00:00:00Z",
		updatedAt: "2026-03-05T00:00:00Z",
	},
];

// Matches MarketplaceThemeDetail from plugins/marketplace.ts
const THEME_DETAILS: Record<string, object> = {
	"minimal-blog": {
		...THEMES[0],
		author: { id: "author-1", ...THEMES[0]!.author },
		repositoryUrl: "https://github.com/emdash-labs/minimal-blog",
		homepageUrl: "https://emdash-labs.dev/themes/minimal-blog",
		license: "MIT",
		screenshotCount: 0,
		screenshotUrls: [],
	},
	"portfolio-pro": {
		...THEMES[1],
		author: { id: "author-2", ...THEMES[1]!.author },
		repositoryUrl: null,
		homepageUrl: null,
		license: "MIT",
		screenshotCount: 0,
		screenshotUrls: [],
	},
};

// ---------------------------------------------------------------------------
// URL patterns
// ---------------------------------------------------------------------------

const PLUGIN_DETAIL_PATTERN = /^\/api\/v1\/plugins\/([^/]+)$/;
const THEME_DETAIL_PATTERN = /^\/api\/v1\/themes\/([^/]+)$/;
const REGISTRY_DID = "did:plc:publisher";
const REGISTRY_SLUG = "gallery";
const REGISTRY_CID = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe";
const registryProfile: unknown = JSON.parse(
	readFileSync(
		new URL("../../packages/registry-verification/fixtures/records/profile.json", import.meta.url),
		"utf8",
	),
);
const registryRelease: unknown = JSON.parse(
	readFileSync(
		new URL("../../packages/registry-verification/fixtures/records/release.json", import.meta.url),
		"utf8",
	),
);
if (
	typeof registryRelease !== "object" ||
	registryRelease === null ||
	!("version" in registryRelease) ||
	typeof registryRelease.version !== "string"
) {
	throw new TypeError("Registry release fixture must include a version");
}
const registryVersion = registryRelease.version;
const REGISTRY_PACKAGE_PATH = "/xrpc/com.emdashcms.experimental.aggregator.getPackage";
const REGISTRY_RELEASES_PATH = "/xrpc/com.emdashcms.experimental.aggregator.listReleases";

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
	const url = new URL(req.url || "/", `http://localhost`);
	const path = url.pathname;

	// CORS
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// Health
	if (path === "/health") {
		json(res, { status: "ok" });
		return;
	}

	if (path === REGISTRY_PACKAGE_PATH && req.method === "GET") {
		json(res, {
			uri: `at://${REGISTRY_DID}/com.emdashcms.experimental.package.profile/${REGISTRY_SLUG}`,
			cid: REGISTRY_CID,
			did: REGISTRY_DID,
			slug: REGISTRY_SLUG,
			profile: registryProfile,
			latestVersion: registryVersion,
			indexedAt: "2026-01-01T00:00:00.000Z",
			labels: [],
		});
		return;
	}

	if (path === REGISTRY_RELEASES_PATH && req.method === "GET") {
		const releases =
			url.searchParams.get("limit") === "100"
				? [
						{
							uri: `at://${REGISTRY_DID}/com.emdashcms.experimental.package.release/${REGISTRY_SLUG}:${registryVersion}`,
							cid: REGISTRY_CID,
							did: REGISTRY_DID,
							package: REGISTRY_SLUG,
							version: registryVersion,
							release: registryRelease,
							artifactCaches: [],
							indexedAt: "2026-01-01T00:00:00.000Z",
							labels: [],
						},
					]
				: [];
		json(res, {
			releases,
		});
		return;
	}

	// Plugin search
	if (path === "/api/v1/plugins" && req.method === "GET") {
		const q = url.searchParams.get("q")?.toLowerCase() || "";
		const capability = url.searchParams.get("capability") || "";
		let items = [...PLUGINS];

		if (q) {
			items = items.filter(
				(p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
			);
		}
		if (capability) {
			items = items.filter((p) => p.capabilities.includes(capability));
		}

		json(res, { items });
		return;
	}

	// Plugin detail
	const pluginMatch = path.match(PLUGIN_DETAIL_PATTERN);
	if (pluginMatch && req.method === "GET") {
		const id = pluginMatch[1]!;
		const detail = PLUGIN_DETAILS[id];
		if (detail) {
			json(res, detail);
		} else {
			json(res, { error: { code: "NOT_FOUND", message: "Plugin not found" } }, 404);
		}
		return;
	}

	// Theme search
	if (path === "/api/v1/themes" && req.method === "GET") {
		const q = url.searchParams.get("q")?.toLowerCase() || "";
		const keyword = url.searchParams.get("keyword") || "";
		let items = [...THEMES];

		if (q) {
			items = items.filter(
				(t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
			);
		}
		if (keyword) {
			items = items.filter((t) => t.keywords.includes(keyword));
		}

		json(res, { items });
		return;
	}

	// Theme detail
	const themeMatch = path.match(THEME_DETAIL_PATTERN);
	if (themeMatch && req.method === "GET") {
		const id = themeMatch[1]!;
		const detail = THEME_DETAILS[id];
		if (detail) {
			json(res, detail);
		} else {
			json(res, { error: { code: "NOT_FOUND", message: "Theme not found" } }, 404);
		}
		return;
	}

	// 404
	json(res, { error: { code: "NOT_FOUND", message: "Not found" } }, 404);
}

function json(res: ServerResponse, data: unknown, status = 200): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export function startMockMarketplace(port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer(handleRequest);
		server.on("error", reject);
		server.listen(port, "127.0.0.1", () => {
			resolve(server);
		});
	});
}

export function stopMockMarketplace(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}
