import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";

import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient, createMockFetch } from "./utils/test-helpers";

vi.mock("../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

vi.mock("../src/components/AdminCommandPalette", () => ({
	AdminCommandPalette: () => null,
}));

vi.mock("../src/routes/users", () => ({
	UsersPage: () => <div>Users page content</div>,
}));

vi.mock("../src/components/WordPressImport", () => ({
	WordPressImport: () => <div>WordPress import content</div>,
}));

vi.mock("../src/components/PluginSettings", () => ({
	PluginSettings: () => <div>Plugin settings content</div>,
}));

// Spread `importOriginal` rather than replacing the module outright: three
// of these four also export siblings that other modules import, and a bare
// factory would drop them and break the import graph.
vi.mock("../src/components/ContentTypeList", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/components/ContentTypeList")>()),
	ContentTypeList: () => <div>Content types content</div>,
}));

vi.mock("../src/components/PluginManager", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/components/PluginManager")>()),
	PluginManager: () => <div>Plugin manager content</div>,
}));

vi.mock("../src/components/MarketplaceBrowse", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/components/MarketplaceBrowse")>()),
	MarketplaceBrowse: () => <div>Marketplace browse content</div>,
}));

vi.mock("../src/components/ThemeMarketplaceBrowse", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/components/ThemeMarketplaceBrowse")>()),
	ThemeMarketplaceBrowse: () => <div>Theme marketplace content</div>,
}));

vi.mock("../src/components/Settings", () => ({
	Settings: () => <div>Settings content</div>,
}));

vi.mock("../src/components/settings/AllowedDomainsSettings", () => ({
	AllowedDomainsSettings: () => <div>Allowed domains content</div>,
}));

vi.mock("../src/components/settings/ApiTokenSettings", () => ({
	ApiTokenSettings: () => <div>API tokens content</div>,
}));

vi.mock("../src/components/settings/BackupSettings", () => ({
	BackupSettings: () => <div>Backups content</div>,
}));

vi.mock("../src/components/settings/EmailSettings", () => ({
	EmailSettings: () => <div>Email settings content</div>,
}));

vi.mock("../src/components/settings/GeneralSettings", () => ({
	GeneralSettings: () => <div>General settings content</div>,
}));

vi.mock("../src/components/settings/SeoSettings", () => ({
	SeoSettings: () => <div>SEO settings content</div>,
}));

vi.mock("../src/components/settings/SocialSettings", () => ({
	SocialSettings: () => <div>Social settings content</div>,
}));

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
};

function buildRouter() {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) {
		i18n.loadAndActivate({ locale: "en", messages: {} });
	}
	function TestApp() {
		return (
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>
		);
	}
	return { router, TestApp };
}

const WRAPPED_ROUTES: Array<[string, string]> = [
	["/settings", "Settings content"],
	["/settings/allowed-domains", "Allowed domains content"],
	["/settings/api-tokens", "API tokens content"],
	["/settings/email", "Email settings content"],
	["/settings/backups", "Backups content"],
	["/settings/general", "General settings content"],
	["/settings/social", "Social settings content"],
	["/settings/seo", "SEO settings content"],
	["/users", "Users page content"],
	["/import/wordpress", "WordPress import content"],
	["/plugins-manager/test-plugin/settings", "Plugin settings content"],
];

// Routes that must stay reachable for a non-admin (Editor-tier reads).
const UNWRAPPED_ROUTES: Array<[string, string]> = [
	["/content-types", "Content types content"],
	["/plugins-manager", "Plugin manager content"],
	["/plugins/marketplace", "Marketplace browse content"],
	["/themes/marketplace", "Theme marketplace content"],
];

describe("admin-only routes show Access denied to non-admins", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	afterEach(() => {
		mockFetch.restore();
	});

	it.each(WRAPPED_ROUTES)(
		"shows Access denied instead of %s for a non-admin (Editor) user",
		async (to, marker) => {
			mockFetch = createMockFetch();
			mockFetch
				.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
				.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 40 } });

			const { router, TestApp } = buildRouter();
			await router.navigate({ to });
			const screen = await render(<TestApp />);

			await expect.element(screen.getByText("Access denied")).toBeInTheDocument();
			await expect.element(screen.getByText(marker)).not.toBeInTheDocument();
		},
	);

	it.each(WRAPPED_ROUTES)("renders %s for an admin", async (to, marker) => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } });

		const { router, TestApp } = buildRouter();
		await router.navigate({ to });
		const screen = await render(<TestApp />);

		await expect.element(screen.getByText(marker)).toBeInTheDocument();
		await expect.element(screen.getByText("Access denied")).not.toBeInTheDocument();
	});
});

describe("routes that stay reachable for non-admins", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	afterEach(() => {
		mockFetch.restore();
	});

	it.each(UNWRAPPED_ROUTES)("renders %s for a non-admin (Editor) user", async (to, marker) => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 40 } })
			// `/content-types` treats a failed collections OR orphans query as a
			// fatal ErrorScreen, which would mask the marker; both are Editor-
			// readable in production (`schema:read`), so both resolve empty here.
			.on("GET", "/_emdash/api/schema/collections", { data: { items: [] } })
			.on("GET", "/_emdash/api/schema/orphans", { data: { items: [] } });

		const { router, TestApp } = buildRouter();
		await router.navigate({ to });
		const screen = await render(<TestApp />);

		await expect.element(screen.getByText(marker)).toBeInTheDocument();
		await expect.element(screen.getByText("Access denied")).not.toBeInTheDocument();
	});
});
