import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

import { TaxonomyManager } from "../../src/components/TaxonomyManager";
import { TaxonomySidebar } from "../../src/components/TaxonomySidebar";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api/client.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/client.js");
	return {
		...actual,
		apiFetch: vi.fn(),
	};
});

import { apiFetch } from "../../src/lib/api/client.js";

const categoriesTaxonomy = {
	id: "tax_categories",
	name: "categories",
	label: "Categories",
	labelSingular: "Category",
	hierarchical: true,
	collections: ["posts"],
};

const genreTaxonomy = {
	id: "tax_genre",
	name: "genre",
	label: "Genres",
	labelSingular: "Genre",
	hierarchical: false,
	collections: ["posts"],
};

const terms = [
	{ id: "1", name: "tech", slug: "tech", label: "Technology", parentId: null, children: [] },
];

function dataResponse(data: unknown) {
	return Promise.resolve(
		new Response(JSON.stringify({ data }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

/** Mirrors the endpoint: counts unless the caller opts out. */
function mockApiFetch() {
	vi.mocked(apiFetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
		const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		const { pathname, searchParams } = new URL(urlString, "http://localhost");
		const method = init?.method ?? "GET";

		if (method === "GET" && pathname === "/_emdash/api/taxonomies") {
			return dataResponse({ taxonomies: [categoriesTaxonomy] });
		}

		if (method === "GET" && pathname === "/_emdash/api/taxonomies/categories/terms") {
			const withCounts = searchParams.get("includeCounts") !== "false";
			return dataResponse({
				terms: terms.map((term) => (withCounts ? { ...term, count: 5 } : term)),
			});
		}

		return dataResponse({});
	});
}

function makeWrapper() {
	// staleTime mirrors App.tsx: inside that window a mounting consumer is served
	// the cached list without refetching.
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: 1000 * 60 },
			mutations: { retry: false },
		},
	});
	return function Wrapper({ children }: { children: React.ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>
				<Toasty>{children}</Toasty>
			</QueryClientProvider>
		);
	};
}

/** The editor sidebar renders first; the settings page mounts afterwards, as it
 * would when the user navigates to it in the same SPA session. */
function EditorThenSettings() {
	const [settingsOpen, setSettingsOpen] = React.useState(false);
	return (
		<>
			<TaxonomySidebar collection="posts" canManageTaxonomies />
			<button type="button" onClick={() => setSettingsOpen(true)}>
				Open settings
			</button>
			{settingsOpen ? <TaxonomyManager taxonomyName="categories" /> : null}
		</>
	);
}

describe("taxonomy term cache", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockApiFetch();
	});

	it("shows real counts in the manager after the editor cached a count-free list", async () => {
		const screen = await render(<EditorThenSettings />, { wrapper: makeWrapper() });

		await screen.getByRole("button", { name: "Choose Categories" }).click();
		await expect.element(screen.getByText("Technology")).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");

		await screen.getByRole("button", { name: "Open settings" }).click();

		await expect.element(screen.getByRole("heading", { name: "Categories" })).toBeInTheDocument();
		await expect.element(screen.getByText("5", { exact: true })).toBeInTheDocument();
	});
});

/** The editor sidebar and the taxonomy page swap places, as the admin routes between them. */
function EditorThenDeleteGenre() {
	const [view, setView] = React.useState<"editor" | "settings">("editor");
	if (view === "settings") {
		return <TaxonomyManager taxonomyName="genre" onDeleted={() => setView("editor")} />;
	}
	return (
		<>
			<TaxonomySidebar collection="posts" canManageTaxonomies />
			<button type="button" onClick={() => setView("settings")}>
				Open settings
			</button>
		</>
	);
}

describe("taxonomy list cache", () => {
	let deleted: boolean;

	beforeEach(() => {
		vi.clearAllMocks();
		deleted = false;
		vi.mocked(apiFetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
			const urlString =
				typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			const { pathname } = new URL(urlString, "http://localhost");
			const method = init?.method ?? "GET";

			if (method === "GET" && pathname === "/_emdash/api/taxonomies") {
				const taxonomies = deleted ? [categoriesTaxonomy] : [categoriesTaxonomy, genreTaxonomy];
				return dataResponse({ taxonomies });
			}
			if (method === "GET" && pathname.endsWith("/terms")) {
				return dataResponse({ terms: [] });
			}
			if (method === "DELETE" && pathname === "/_emdash/api/taxonomies/genre") {
				deleted = true;
				return dataResponse({ deleted: true });
			}

			return dataResponse({});
		});
	});

	it("drops a deleted taxonomy from an editor sidebar that cached it", async () => {
		const screen = await render(<EditorThenDeleteGenre />, { wrapper: makeWrapper() });
		await expect.element(screen.getByRole("button", { name: "Choose Genres" })).toBeInTheDocument();

		await screen.getByRole("button", { name: "Open settings" }).click();
		await screen.getByRole("button", { name: "More actions for Genres" }).click();
		await screen.getByRole("menuitem", { name: "Delete taxonomy" }).click();
		await expect
			.element(screen.getByRole("heading", { name: "Delete Taxonomy" }))
			.toBeInTheDocument();
		// Direct DOM click to bypass Base UI inert overlay
		screen.getByRole("button", { name: "Delete" }).element().click();

		await expect.element(screen.getByText("Categories", { exact: true })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Choose Genres" }))
			.not.toBeInTheDocument();
	});
});
