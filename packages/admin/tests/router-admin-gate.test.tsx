/**
 * Regression coverage for the route groups audited alongside the
 * `/settings` admin gate (card emdb-023). All of them are nav-hidden below
 * `ROLE_ADMIN` in `router.tsx`, but the server's own RBAC tiers
 * (`packages/auth/src/rbac.ts`) differ per route, so only some of them
 * belong behind the `RequireAdmin` guard:
 *
 * - `/settings` and its 7 sub-pages, `/users`, and `/import/wordpress`:
 *   every server read is `Role.ADMIN` (`users:read`, `import:execute`, or
 *   the settings endpoints), so these ARE wrapped in `RequireAdmin` —
 *   verified below by rendering all 11 routes.
 * - `/plugins-manager/$pluginId/settings`: both the GET and the PUT of the
 *   plugin settings resource are `plugins:manage` (`Role.ADMIN`), and the
 *   page's only Editor-tier read (`fetchPlugin`) is display chrome that
 *   stays reachable on `/plugins-manager` — so this one IS wrapped too.
 * - `/content-types`, `/plugins-manager`, `/plugins/marketplace`, and
 *   `/themes/marketplace`: the server enforces only `Role.EDITOR` for reads
 *   (`schema:read` / `plugins:read`), so wrapping them in `RequireAdmin`
 *   would regress Editor access the RBAC model deliberately grants. These
 *   four are covered by `UNWRAPPED_ROUTES` below, which mounts each one
 *   through the router as an Editor and asserts the page still renders.
 *   That negative space is the point: their own component tests
 *   (`PluginManager.test.tsx`, `MarketplacePluginDetail.test.tsx`, …) mount
 *   the components directly, never through the router with a role-mocked
 *   user, so nothing there would catch an accidental `RequireAdmin` wrap —
 *   it would ship silently. This file is the only place that can.
 */

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

// The four deliberately-unwrapped pages (see UNWRAPPED_ROUTES). Their route
// components are thin wrappers in router.tsx that pass query data down, so
// stubbing the leaf component is enough to give each route a marker.
//
// These spread `importOriginal` rather than replacing the module outright:
// three of the four also export siblings that other modules import
// (`moveCollection`, `MarketplaceInstallMessage`, `UninstallConfirmDialog`,
// `AuditBadge`), and a bare factory drops them, breaking the import graph.
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

/**
 * The mirror image of WRAPPED_ROUTES: routes that must STAY reachable for a
 * non-admin. Every read behind these is `Role.EDITOR` or below, so a
 * `RequireAdmin` wrapper here would be a capability regression shipped as a
 * security fix — the failure mode this table exists to catch.
 */
const UNWRAPPED_ROUTES: Array<[string, string]> = [
	["/content-types", "Content types content"],
	["/plugins-manager", "Plugin manager content"],
	["/plugins/marketplace", "Marketplace browse content"],
	["/themes/marketplace", "Theme marketplace content"],
];

describe("RequireAdmin-wrapped routes (emdb-023): /settings + 7 sub-pages, /users, /import/wordpress, plugin settings", () => {
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

describe("deliberately UNWRAPPED routes (emdb-023): still reachable for a non-admin", () => {
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
