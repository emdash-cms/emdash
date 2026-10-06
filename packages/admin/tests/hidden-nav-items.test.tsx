import { LinkProvider, Toasty, type LinkComponentProps } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";

function manifestHiding(hiddenNavItems?: string[]): AdminManifest {
	return {
		version: "1.0.0",
		hash: `hidden-nav-${hiddenNavItems?.join(",") ?? "none"}`,
		authMode: "passkey",
		collections: {
			posts: { label: "Posts", labelSingular: "Post", supports: [], hasSeo: false, fields: {} },
		},
		plugins: {},
		taxonomies: [],
		admin: hiddenNavItems ? { hiddenNavItems } : undefined,
	};
}

const TestLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
	({ href, to, children, ...props }, ref) => (
		<a ref={ref} href={href ?? to} {...props}>
			{children}
		</a>
	),
);
TestLink.displayName = "TestLink";

function json(data: unknown) {
	return Promise.resolve(
		new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }),
	);
}

function requestUrl(input: string | URL | Request) {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

let manifest: AdminManifest;

async function sidebarLinks() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 60_000 } },
	});
	const router = createAdminRouter(queryClient);
	await router.navigate({ to: "/" });

	const screen = await render(
		<ThemeProvider defaultTheme="light">
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<LinkProvider component={TestLink}>
							<RouterProvider router={router} />
						</LinkProvider>
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>
		</ThemeProvider>,
	);
	await expect.element(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
	await expect.element(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
	return Array.from(document.querySelectorAll("a"), (link) => link.textContent?.trim());
}

const ALL = [
	"calendar",
	"media",
	"comments",
	"menus",
	"redirects",
	"widgets",
	"sections",
	"bylines",
	"import",
];
const LABELS = [
	"Calendar",
	"Media",
	"Comments",
	"Menus",
	"Redirects",
	"Widgets",
	"Sections",
	"Bylines",
	"Import",
	"Upload Media",
];

describe("admin.hiddenNavItems", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		localStorage.clear();
		i18n.loadAndActivate({ locale: "en", messages: {} });
		globalThis.fetch = vi.fn((input: string | URL | Request) => {
			const url = requestUrl(input);
			if (url === "/_emdash/api/manifest") return json({ data: manifest });
			if (url === "/_emdash/api/auth/me") {
				return json({ data: { id: "admin", email: "admin@example.com", name: "Admin", role: 50 } });
			}
			if (url === "/_emdash/api/admin/comments/counts") {
				return json({ data: { pending: 0, approved: 0, spam: 0, trash: 0 } });
			}
			if (url === "/_emdash/api/dashboard") {
				return json({ data: { collections: [], mediaCount: 0, userCount: 0, recentItems: [] } });
			}
			if (url === "/_emdash/api/admin/transfer/capabilities") {
				return json({
					data: { portableDomain: { empty: false, blockers: [], seededScaffold: [] } },
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("shows every built-in area when nothing is hidden", async () => {
		manifest = manifestHiding();
		const links = await sidebarLinks();
		for (const label of LABELS) expect(links).toContain(label);
	});

	it("leaves hidden built-in areas out of the sidebar and dashboard shortcuts", async () => {
		manifest = manifestHiding(ALL);
		const links = await sidebarLinks();
		for (const label of LABELS) expect(links).not.toContain(label);
		expect(links).toEqual(expect.arrayContaining(["Posts", "Settings"]));
	});

	it("skips the pending-comment count when comments are hidden", async () => {
		manifest = manifestHiding(["comments"]);
		await sidebarLinks();
		const requested = vi.mocked(globalThis.fetch).mock.calls.map(([input]) => requestUrl(input));
		expect(requested).toContain("/_emdash/api/auth/me");
		expect(requested).not.toContain("/_emdash/api/admin/comments/counts");
	});
});
