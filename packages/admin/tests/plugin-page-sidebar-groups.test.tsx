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

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "plugin-page-groups",
	authMode: "passkey",
	collections: {
		events: {
			label: "Events",
			labelSingular: "Event",
			supports: [],
			hasSeo: false,
			fields: {},
			group: "Calendar",
		},
		posts: { label: "Posts", labelSingular: "Post", supports: [], hasSeo: false, fields: {} },
	},
	plugins: {
		"calendar-sync": {
			enabled: true,
			adminMode: "blocks",
			adminPages: [
				{ path: "/sync", label: "Sync", group: "Calendar" },
				{ path: "/log", label: "Log", group: "Tools" },
				{ path: "/about", label: "About" },
			],
		},
	},
	taxonomies: [],
};

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

async function renderDashboard() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 60_000 } },
	});
	const router = createAdminRouter(queryClient);
	await router.navigate({ to: "/" });

	return render(
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
}

describe("plugin admin page sidebar groups", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		localStorage.clear();
		i18n.loadAndActivate({ locale: "en", messages: {} });
		globalThis.fetch = vi.fn((input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
			throw new Error(`Unexpected request: ${url}`);
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("places a page in the collection folder its group names, after the collections", async () => {
		const screen = await renderDashboard();
		const calendar = screen.getByRole("button", { name: "Calendar" });
		await calendar.click();

		const folder = calendar.element().closest("li")!;
		const links = Array.from(folder.querySelectorAll("a"), (link) => link.textContent?.trim());
		expect(links).toEqual(["Events", "Sync"]);
	});

	it("folds pages with any other group into a folder in the Plugins section", async () => {
		const screen = await renderDashboard();
		const tools = screen.getByRole("button", { name: "Tools" });
		await tools.click();

		const folder = tools.element().closest("li")!;
		const links = Array.from(folder.querySelectorAll("a"), (link) => link.textContent?.trim());
		expect(links).toEqual(["Log"]);
		await expect.element(screen.getByRole("link", { name: "About" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "About" }).element().closest("li")).not.toBe(folder);
	});
});
