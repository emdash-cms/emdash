import { LinkProvider, Toasty, type LinkComponentProps } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";

const category = {
	id: "category",
	name: "category",
	label: "Categories",
	labelSingular: "Category",
	hierarchical: true,
	collections: ["posts"],
	locale: "en",
	translationGroup: "category",
};

const genre = {
	id: "genre",
	name: "genre",
	label: "Genres",
	labelSingular: "Genre",
	hierarchical: false,
	collections: ["posts"],
	locale: "en",
	translationGroup: "genre",
};

const initialManifest: AdminManifest = {
	version: "1.0.0",
	hash: "initial",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: [],
			hasSeo: false,
			fields: {},
		},
	},
	plugins: {},
	taxonomies: [category],
};

const refreshedManifest: AdminManifest = {
	...initialManifest,
	hash: "refreshed",
	taxonomies: [category, genre],
};

const TestLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
	({ href, to, children, ...props }, ref) => (
		<a ref={ref} href={href ?? to} {...props}>
			{children}
		</a>
	),
);
TestLink.displayName = "TestLink";

function json(data: unknown, status = 200) {
	return Promise.resolve(
		new Response(JSON.stringify(data), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

/** Render the whole admin, parked on one taxonomy's page. */
async function renderAdminAt(taxonomy: string) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0, staleTime: 60_000 },
			mutations: { retry: false },
		},
	});
	const router = createAdminRouter(queryClient);
	await router.navigate({ to: "/taxonomies/$taxonomy", params: { taxonomy } });

	function TestApp() {
		return (
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
			</ThemeProvider>
		);
	}

	return render(<TestApp />);
}

describe("taxonomy sidebar refresh", () => {
	let originalFetch: typeof fetch;
	let manifestFetches: number;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		manifestFetches = 0;
		i18n.loadAndActivate({ locale: "en", messages: {} });

		globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = init?.method ?? "GET";

			if (method === "GET" && url === "/_emdash/api/manifest") {
				manifestFetches += 1;
				return json({ data: manifestFetches === 1 ? initialManifest : refreshedManifest });
			}
			if (method === "GET" && url === "/_emdash/api/auth/me") {
				return json({
					data: { id: "admin", email: "admin@example.com", name: "Admin", role: 50 },
				});
			}
			if (method === "GET" && url === "/_emdash/api/admin/comments/counts") {
				return json({ data: { pending: 0, approved: 0, spam: 0, trash: 0 } });
			}
			if (method === "GET" && url === "/_emdash/api/taxonomies") {
				return json({ data: { taxonomies: [category, genre] } });
			}
			if (method === "GET" && url.startsWith("/_emdash/api/taxonomies/category/terms")) {
				return json({ data: { terms: [] } });
			}
			if (method === "POST" && url === "/_emdash/api/taxonomies") {
				return json({ data: { taxonomy: genre } }, 201);
			}

			throw new Error(`Unexpected request: ${method} ${url}`);
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("shows a newly created taxonomy in the sidebar without reloading", async () => {
		const screen = await renderAdminAt("category");
		await expect.element(screen.getByRole("link", { name: "Categories" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Genres" }).query()).toBeNull();

		await screen.getByRole("button", { name: "New Taxonomy" }).click();
		await screen.getByRole("textbox", { name: "Label" }).fill("Genres");
		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByRole("link", { name: "Genres" })).toBeInTheDocument();
		expect(manifestFetches).toBe(2);
	});
});

describe("taxonomy sidebar after deletion", () => {
	let originalFetch: typeof fetch;
	let manifestFetches: number;
	let requests: string[];

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		manifestFetches = 0;
		requests = [];
		i18n.loadAndActivate({ locale: "en", messages: {} });

		globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = init?.method ?? "GET";
			requests.push(`${method} ${url}`);

			if (method === "GET" && url === "/_emdash/api/manifest") {
				manifestFetches += 1;
				return json({ data: manifestFetches === 1 ? refreshedManifest : initialManifest });
			}
			if (method === "GET" && url === "/_emdash/api/auth/me") {
				return json({
					data: { id: "admin", email: "admin@example.com", name: "Admin", role: 50 },
				});
			}
			if (method === "GET" && url === "/_emdash/api/admin/comments/counts") {
				return json({ data: { pending: 0, approved: 0, spam: 0, trash: 0 } });
			}
			if (method === "GET" && url === "/_emdash/api/dashboard") {
				return json({ data: { collections: [], mediaCount: 0, userCount: 0, recentItems: [] } });
			}
			if (method === "GET" && url === "/_emdash/api/taxonomies") {
				const deleted = requests.includes("DELETE /_emdash/api/taxonomies/genre");
				const taxonomies = deleted ? [category] : [category, genre];
				return json({ data: { taxonomies } });
			}
			if (method === "GET" && url.startsWith("/_emdash/api/taxonomies/genre/terms")) {
				return json({ data: { terms: [] } });
			}
			if (method === "DELETE" && url === "/_emdash/api/taxonomies/genre") {
				return json({ data: { deleted: true } });
			}

			throw new Error(`Unexpected request: ${method} ${url}`);
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("removes a deleted taxonomy from the sidebar and leaves its page", async () => {
		const screen = await renderAdminAt("genre");
		await expect.element(screen.getByRole("link", { name: "Genres" })).toBeInTheDocument();

		await screen.getByRole("button", { name: "More actions for Genres" }).click();
		await screen.getByRole("menuitem", { name: "Delete taxonomy" }).click();
		await expect
			.element(screen.getByRole("heading", { name: "Delete Taxonomy" }))
			.toBeInTheDocument();
		// Direct DOM click to bypass Base UI inert overlay
		screen.getByRole("button", { name: "Delete" }).element().click();

		await expect.element(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
		await expect.element(screen.getByRole("link", { name: "Genres" })).not.toBeInTheDocument();
		const deleteAt = requests.indexOf("DELETE /_emdash/api/taxonomies/genre");
		expect(deleteAt).toBeGreaterThanOrEqual(0);
		expect(requests.slice(deleteAt + 1).filter((r) => r.includes("/taxonomies"))).toEqual([]);
	});
});
