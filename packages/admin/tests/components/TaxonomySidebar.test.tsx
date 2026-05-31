import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

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

interface TestTaxonomy {
	id: string;
	name: string;
	label: string;
	labelSingular?: string;
	hierarchical: boolean;
	collections: string[];
}

interface TestTerm {
	id: string;
	name: string;
	slug: string;
	label: string;
	parentId?: string | null;
	children: TestTerm[];
}

const tagsTaxonomy: TestTaxonomy = {
	id: "tax_tags",
	name: "tags",
	label: "Tags",
	labelSingular: "Tag",
	hierarchical: false,
	collections: ["products"],
};

const categoriesTaxonomy: TestTaxonomy = {
	id: "tax_categories",
	name: "categories",
	label: "Categories",
	labelSingular: "Category",
	hierarchical: true,
	collections: ["products"],
};

const alphaTerm = makeTerm("term_alpha", "Alpha");
const betaTerm = makeTerm("term_beta", "Beta");

function makeTerm(id: string, label: string): TestTerm {
	return {
		id,
		name: label.toLowerCase(),
		slug: label.toLowerCase(),
		label,
		parentId: null,
		children: [],
	};
}

function dataResponse(data: unknown) {
	return Promise.resolve(
		new Response(JSON.stringify({ data }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

function mockApiFetch({
	taxonomies = [tagsTaxonomy],
	terms = [alphaTerm, betaTerm],
	entryTerms = [],
}: {
	taxonomies?: TestTaxonomy[];
	terms?: TestTerm[];
	entryTerms?: TestTerm[];
} = {}) {
	vi.mocked(apiFetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
		const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		const method = init?.method ?? "GET";

		if (method === "GET" && urlString === "/_emdash/api/taxonomies") {
			return dataResponse({ taxonomies });
		}

		if (method === "GET" && urlString === "/_emdash/api/taxonomies/tags/terms") {
			return dataResponse({ terms });
		}

		if (method === "GET" && urlString === "/_emdash/api/taxonomies/categories/terms") {
			return dataResponse({ terms });
		}

		if (
			method === "GET" &&
			urlString === "/_emdash/api/content/products/entry_1/terms/tags"
		) {
			return dataResponse({ terms: entryTerms });
		}

		return dataResponse({});
	});
}

function Wrapper({ children }: { children: React.ReactNode }) {
	const queryClient = React.useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
			}),
		[],
	);

	return (
		<QueryClientProvider client={queryClient}>
			<Toasty>{children}</Toasty>
		</QueryClientProvider>
	);
}

describe("TaxonomySidebar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockApiFetch();
	});

	it("shows existing flat taxonomy terms when the tag picker receives focus", async () => {
		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });

		await expect.element(screen.getByLabelText("Add Tags")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Alpha$/ }).query()).toBeNull();

		await screen.getByLabelText("Add Tags").click();

		await expect.element(screen.getByRole("button", { name: /^Alpha$/ })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: /^Beta$/ })).toBeInTheDocument();
	});

	it("filters flat taxonomy terms while preserving the create option for new input", async () => {
		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });

		const input = screen.getByLabelText("Add Tags");
		await input.fill("Alp");

		await expect.element(screen.getByRole("button", { name: /^Alpha$/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Beta$/ }).query()).toBeNull();
		await expect.element(screen.getByText('Create "Alp"')).toBeInTheDocument();
	});

	it("does not suggest terms already assigned to the entry", async () => {
		mockApiFetch({ entryTerms: [alphaTerm] });

		const screen = await render(<TaxonomySidebar collection="products" entryId="entry_1" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
		await screen.getByLabelText("Add Tags").click();

		expect(screen.getByRole("button", { name: /^Alpha$/ }).query()).toBeNull();
		await expect.element(screen.getByRole("button", { name: /^Beta$/ })).toBeInTheDocument();
	});

	it("keeps the create prompt available when no flat taxonomy terms exist", async () => {
		mockApiFetch({ terms: [] });

		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });

		const input = screen.getByLabelText("Add Tags");
		await input.click();

		expect(screen.getByText('Create "Gamma"').query()).toBeNull();

		await input.fill("Gamma");

		await expect.element(screen.getByText('Create "Gamma"')).toBeInTheDocument();
	});

	it("continues to render hierarchical taxonomies as a checkbox tree", async () => {
		mockApiFetch({ taxonomies: [categoriesTaxonomy], terms: [alphaTerm] });

		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Categories")).toBeInTheDocument();
		await expect.element(screen.getByText("Alpha")).toBeInTheDocument();
		expect(screen.getByLabelText("Add Categories").query()).toBeNull();
	});
});
