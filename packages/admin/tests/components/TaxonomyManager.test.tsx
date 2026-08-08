import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
	getAvailableParentTerms,
	replaceSiblingGroup,
	reorderWithinSlots,
	TaxonomyManager,
} from "../../src/components/TaxonomyManager";
import type { TaxonomyTerm } from "../../src/lib/api/taxonomies.js";
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

/** Two siblings under one parent, so a nested group can actually be reordered. */
const nestedSiblingsTermsResponse = JSON.stringify({
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
						id: "fonts",
						name: "fonts",
						slug: "fonts",
						label: "Fonts",
						parentId: "design-group",
						translationGroup: "fonts-group",
						children: [],
						count: 0,
					},
					{
						id: "colour",
						name: "colour",
						slug: "colour",
						label: "Colour",
						parentId: "design-group",
						translationGroup: "colour-group",
						children: [],
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

/**
 * A term whose parent has no row in this locale, rendered between two real
 * roots. The server lists it at the top level so it isn't lost, but it belongs
 * to its parent's group and can't be moved or named from here.
 */
const untranslatedParentTermsResponse = JSON.stringify({
	data: {
		terms: [
			{
				id: "beta",
				name: "beta",
				slug: "beta",
				label: "Beta",
				parentId: null,
				translationGroup: "beta-group",
				children: [],
				count: 0,
			},
			{
				id: "nino",
				name: "nino",
				slug: "nino",
				label: "Nino",
				parentId: "alpha-group",
				translationGroup: "nino-group",
				children: [],
				count: 0,
			},
			{
				id: "gamma",
				name: "gamma",
				slug: "gamma",
				label: "Gamma",
				parentId: null,
				translationGroup: "gamma-group",
				children: [],
				count: 0,
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

	/** Parsed body of the reorder request, or undefined if none was sent. */
	function reorderRequestBody(): unknown {
		const call = vi
			.mocked(apiFetch)
			.mock.calls.find(([url]) => typeof url === "string" && url.includes("/reorder"));
		const body = call?.[1]?.body;
		return typeof body === "string" ? JSON.parse(body) : undefined;
	}

	it("moving a term sends the whole sibling group in its new order", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();

		await screen.getByRole("button", { name: "Move Technology down" }).click();

		expect(reorderRequestBody()).toEqual({ parentId: null, ids: ["2", "1"] });
	});

	it("cannot move the first term up or the last term down", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();

		await expect.element(screen.getByRole("button", { name: "Move Technology up" })).toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Move Science down" })).toBeDisabled();
		await expect
			.element(screen.getByRole("button", { name: "Move Technology down" }))
			.toBeEnabled();
	});

	it("reorders the top level while nested rows are on screen", async () => {
		mockApiFetch(hierarchicalTermsResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Test", { exact: true })).toBeInTheDocument();

		await screen.getByRole("button", { name: "Move Design down" }).click();

		expect(reorderRequestBody()).toEqual({
			parentId: null,
			ids: ["development-group", "design-group"],
		});
	});

	it("reorders a nested group under its own parent, leaving the roots alone", async () => {
		mockApiFetch(nestedSiblingsTermsResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Fonts", { exact: true })).toBeInTheDocument();

		await screen.getByRole("button", { name: "Move Fonts down" }).click();

		expect(reorderRequestBody()).toEqual({
			parentId: "design-group",
			ids: ["colour-group", "fonts-group"],
		});
	});

	it("cannot move a term whose parent is untranslated", async () => {
		mockApiFetch(untranslatedParentTermsResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Nino", { exact: true })).toBeInTheDocument();

		await expect.element(screen.getByRole("button", { name: "Move Nino up" })).toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Move Nino down" })).toBeDisabled();
	});

	it("leaves an untranslated-parent term out of the group it is drawn in", async () => {
		mockApiFetch(untranslatedParentTermsResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Gamma", { exact: true })).toBeInTheDocument();

		// Beta and Gamma are the only real roots, so Beta's "down" is enabled even
		// though Nino sits between them, and Nino is not named in the request.
		await screen.getByRole("button", { name: "Move Beta down" }).click();

		expect(reorderRequestBody()).toEqual({
			parentId: null,
			ids: ["gamma-group", "beta-group"],
		});
	});

	it("splices a reordered child group into its parent, leaving the roots alone", () => {
		const terms: TaxonomyTerm[] = JSON.parse(nestedSiblingsTermsResponse).data.terms;
		const [fonts, colour] = terms[0]!.children;

		const next = replaceSiblingGroup(terms, "design-group", [colour!, fonts!]);

		expect(next.map((term) => term.label)).toEqual(["Design", "Development"]);
		expect(next[0]!.children.map((term) => term.label)).toEqual(["Colour", "Fonts"]);
	});

	it("permutes movable terms within their slots, leaving the rest in place", () => {
		const terms: TaxonomyTerm[] = JSON.parse(untranslatedParentTermsResponse).data.terms;
		const [beta, nino, gamma] = terms;
		const movable = [beta!, gamma!];

		const next = reorderWithinSlots(terms, movable, [gamma!, beta!]);

		// Nino keeps the slot it was rendered in; Beta and Gamma swap the two
		// slots they held around it.
		expect(next.map((term) => term.label)).toEqual(["Gamma", "Nino", "Beta"]);
		expect(next[1]).toBe(nino);
	});

	it("replaces the root list when ordering the top level", () => {
		const terms: TaxonomyTerm[] = JSON.parse(nestedSiblingsTermsResponse).data.terms;

		const next = replaceSiblingGroup(terms, null, [terms[1]!, terms[0]!]);

		expect(next.map((term) => term.label)).toEqual(["Development", "Design"]);
	});

	it("shows empty state when no terms", async () => {
		mockApiFetch(JSON.stringify({ data: { terms: [] } }));

		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText(NO_CATEGORIES_REGEX)).toBeInTheDocument();
	});
});
