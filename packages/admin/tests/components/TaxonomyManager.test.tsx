import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { getAvailableParentTerms, TaxonomyManager } from "../../src/components/TaxonomyManager";
import { render } from "../utils/render.tsx";

const taxonomyResponse = JSON.stringify({
	data: {
		taxonomies: [
			{
				id: "t1",
				name: "categories",
				label: "Categories",
				labelSingular: "Category",
				hierarchical: true,
				collections: ["posts"],
			},
		],
	},
});

const termsResponse = JSON.stringify({
	data: {
		terms: [
			{
				id: "1",
				name: "tech",
				slug: "tech",
				label: "Technology",
				parentId: null,
				children: [],
				count: 5,
			},
			{
				id: "2",
				name: "science",
				slug: "science",
				label: "Science",
				parentId: null,
				children: [],
				count: 3,
			},
		],
	},
});

const hierarchicalTermsResponse = JSON.stringify({
	data: {
		terms: [
			{
				id: "design",
				name: "design",
				slug: "design",
				label: "Design",
				parentId: null,
				translationGroup: "design-group",
				children: [
					{
						id: "test",
						name: "test",
						slug: "test",
						label: "Test",
						parentId: "design-group",
						translationGroup: "test-group",
						children: [
							{
								id: "test-child",
								name: "test-child",
								slug: "test-child",
								label: "Test child",
								parentId: "test-group",
								translationGroup: "test-child-group",
								children: [],
								count: 0,
							},
						],
						count: 0,
					},
				],
				count: 1,
			},
			{
				id: "development",
				name: "development",
				slug: "development",
				label: "Development",
				parentId: null,
				translationGroup: "development-group",
				children: [],
				count: 4,
			},
		],
	},
});

vi.mock("../../src/lib/api/client.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/client.js");
	return {
		...actual,
		apiFetch: vi.fn(),
	};
});

import { apiFetch } from "../../src/lib/api/client.js";

function mockApiFetch(overrideTerms?: string) {
	vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
		const urlStr = typeof url === "string" ? url : "";
		if (urlStr.includes("/terms") && (!init || !init.method || init.method === "GET")) {
			return Promise.resolve(
				new Response(overrideTerms ?? termsResponse, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
		if (urlStr.includes("/taxonomies") && (!init || !init.method || init.method === "GET")) {
			return Promise.resolve(
				new Response(taxonomyResponse, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}
		return Promise.resolve(
			new Response(JSON.stringify({ data: { success: true } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});
}

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<Toasty>
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		</Toasty>
	);
}

const ADD_CATEGORY_BUTTON_REGEX = /Add Category/;
const ADD_CATEGORY_HEADING_REGEX = /Add Category/;
const EDIT_CATEGORY_HEADING_REGEX = /Edit Category/;
const PARENT_SELECTOR_REGEX = /Parent/;
const NO_CATEGORIES_REGEX = /No categories yet/;
const DELETE_CATEGORY_HEADING_REGEX = /Delete Category/i;
const DELETE_TECHNOLOGY_DESC_REGEX = /permanently delete "Technology"/;

describe("TaxonomyManager", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockApiFetch();
	});

	it("displays taxonomy name as heading", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByRole("heading", { name: "Categories" })).toBeInTheDocument();
	});

	it("shows list of terms with labels", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		// Use locators that target the specific label spans (font-medium class)
		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();
		// "Science" also appears in "(science)" slug, so target the font-medium span
		await expect.element(screen.getByText("(science)")).toBeInTheDocument();
	});

	it("shows term slugs in parentheses", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("(tech)")).toBeInTheDocument();
		await expect.element(screen.getByText("(science)")).toBeInTheDocument();
	});

	it("add button opens create dialog", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		// Wait for content to load, then click the button
		await expect.element(screen.getByRole("heading", { name: "Categories" })).toBeInTheDocument();

		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();

		// Verify the dialog heading opened
		await expect
			.element(screen.getByRole("heading", { name: ADD_CATEGORY_HEADING_REGEX }))
			.toBeInTheDocument();
	});

	it("create dialog has name, slug, and description inputs", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByRole("heading", { name: "Categories" })).toBeInTheDocument();

		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();

		await expect.element(screen.getByLabelText("Name")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Slug")).toBeInTheDocument();
		// The InputArea uses "Description (optional)" as label
		await expect.element(screen.getByText("Description (optional)")).toBeInTheDocument();
	});

	it("shows parent selector for hierarchical taxonomies", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByRole("heading", { name: "Categories" })).toBeInTheDocument();

		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();

		await expect.element(screen.getByLabelText(PARENT_SELECTOR_REGEX)).toBeInTheDocument();
	});

	it("lists each nested term once in the parent selector", () => {
		const terms = JSON.parse(hierarchicalTermsResponse).data.terms;
		const labels = getAvailableParentTerms(terms).map((term) => term.label);

		expect(labels).toEqual(["Design", "Test", "Test child", "Development"]);
	});

	it("excludes the edited term and all descendants from parent choices", () => {
		const terms = JSON.parse(hierarchicalTermsResponse).data.terms;
		const labels = getAvailableParentTerms(terms, terms[0]).map((term) => term.label);

		expect(labels).toEqual(["Development"]);
	});

	it("selects the current parent by translation group when editing a nested term", async () => {
		mockApiFetch(hierarchicalTermsResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Test", { exact: true })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Edit Test", exact: true }).click();

		await expect.element(screen.getByLabelText(PARENT_SELECTOR_REGEX)).toHaveTextContent("Design");
	});

	it("edit button opens dialog", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();

		await screen.getByRole("button", { name: "Edit Technology" }).click();

		// Should open the edit dialog with "Edit Category" heading
		await expect
			.element(screen.getByRole("heading", { name: EDIT_CATEGORY_HEADING_REGEX }))
			.toBeInTheDocument();
	});

	it("delete button opens confirm dialog", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();

		await screen.getByRole("button", { name: "Delete Technology" }).click();

		// Should open a ConfirmDialog (not window.confirm)
		await expect
			.element(screen.getByRole("heading", { name: DELETE_CATEGORY_HEADING_REGEX }))
			.toBeInTheDocument();
		await expect.element(screen.getByText(DELETE_TECHNOLOGY_DESC_REGEX)).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
	});

	it("shows empty state when no terms", async () => {
		mockApiFetch(JSON.stringify({ data: { terms: [] } }));

		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText(NO_CATEGORIES_REGEX)).toBeInTheDocument();
	});
});
