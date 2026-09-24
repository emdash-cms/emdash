import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

import {
	getAvailableParentTerms,
	replaceSiblingGroup,
	reorderWithinSlots,
	TaxonomyManager,
} from "../../src/components/TaxonomyManager";
import type { TaxonomyTerm } from "../../src/lib/api/taxonomies.js";

import "../../dist/styles.css";
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

const tagTaxonomyResponse = JSON.stringify({
	data: {
		taxonomies: [
			{
				id: "tag",
				name: "tag",
				label: "Tags",
				labelSingular: "Tag",
				hierarchical: false,
				collections: ["posts", "pages"],
			},
		],
	},
});

const hierarchicalTagTaxonomyResponse = JSON.stringify({
	data: {
		taxonomies: [
			{
				id: "tag",
				name: "tag",
				label: "Tags",
				labelSingular: "Tag",
				hierarchical: true,
				collections: ["posts"],
			},
		],
	},
});

let manifestI18n: { defaultLocale: string; locales: string[] } | undefined;

const turkishTermsResponse = JSON.stringify({
	data: {
		terms: [
			{
				id: "permission",
				name: "permission",
				slug: "permission",
				label: "İzin",
				parentId: null,
				locale: "tr",
				translationGroup: "permission",
				children: [],
				count: 1,
			},
			{
				id: "music",
				name: "music",
				slug: "INDIE",
				label: "Music",
				parentId: null,
				locale: "tr",
				translationGroup: "music",
				children: [],
				count: 1,
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
		fetchManifest: vi.fn(async () => ({ collections: {}, i18n: manifestI18n })),
	};
});

import { apiFetch } from "../../src/lib/api/client.js";

/**
 * Hold the reorder responses until `release()` is called, so a test can look at
 * the list while the request is still in flight.
 */
function deferReorders() {
	const pending: Array<() => void> = [];
	let open = false;
	const ok = () =>
		new Response(JSON.stringify({ data: { reordered: true } }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	return {
		hold: (): Promise<Response> => {
			// `scope` serializes the reorder mutation, so a queued move only calls
			// this once the one before it settles — stay open so those land too.
			if (open) return Promise.resolve(ok());
			return new Promise((resolve) => pending.push(() => resolve(ok())));
		},
		release: () => {
			open = true;
			for (const settle of pending.splice(0)) settle();
		},
		get inFlight() {
			return pending.length;
		},
	};
}

function mockApiFetch(
	overrideTerms?: string,
	defer?: ReturnType<typeof deferReorders>,
	overrideTaxonomies?: string,
) {
	vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
		const urlStr = typeof url === "string" ? url : "";
		if (defer && urlStr.includes("/reorder")) return defer.hold();
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
				new Response(overrideTaxonomies ?? taxonomyResponse, {
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
		manifestI18n = undefined;
		mockApiFetch();
	});

	it("displays taxonomy name as heading", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByRole("heading", { name: "Categories" })).toBeInTheDocument();
	});

	it("keeps the two tag actions together and moves taxonomy creation into More", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });

		await expect.element(screen.getByRole("button", { name: "Add tag" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Add to posts" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "New Taxonomy" }).query()).toBeNull();

		await screen.getByRole("button", { name: "More actions for Tags" }).click();
		await screen.getByRole("menuitem", { name: "New taxonomy" }).click();
		await expect.element(screen.getByRole("dialog")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("heading", { name: "Create Taxonomy" }))
			.toBeInTheDocument();
	});

	it("creates a taxonomy from the dialog footer", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		await screen.getByRole("button", { name: "More actions for Tags" }).click();
		await screen.getByRole("menuitem", { name: "New taxonomy" }).click();

		const dialog = screen.getByRole("dialog");
		await dialog.getByRole("textbox", { name: "Label" }).fill("Topics");
		await expect.element(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("topics");
		await dialog.getByRole("button", { name: "Create Taxonomy" }).click();

		await vi.waitFor(() => {
			const call = vi
				.mocked(apiFetch)
				.mock.calls.find(
					([url, init]) =>
						typeof url === "string" && url.endsWith("/taxonomies") && init?.method === "POST",
				);
			expect(call).toBeDefined();
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toMatchObject({ name: "topics", label: "Topics", hierarchical: false });
		});
	});

	it("shows slug guidance beside the label only when requested", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		await screen.getByRole("button", { name: "Add tag" }).click();

		const nameInput = screen.getByRole("textbox", { name: "Name" });
		const slugInput = screen.getByRole("textbox", { name: "Slug" });
		await expect.element(nameInput).toBeInTheDocument();
		await expect.element(slugInput).toBeInTheDocument();
		expect(screen.getByText("Auto-generated from name (you can edit)").query()).toBeNull();

		await screen.getByRole("button", { name: "How is the slug generated?" }).hover();
		await expect.element(screen.getByText("Auto-generated from name (you can edit)")).toBeVisible();
		await screen.getByText("Slug", { exact: true }).click();
		await expect.element(slugInput).toHaveFocus();
	});

	it("creates a tag from the dialog footer", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		await screen.getByRole("button", { name: "Add tag" }).click();
		await screen.getByRole("textbox", { name: "Name" }).fill("Internship Experience");
		await screen.getByRole("dialog").getByRole("button", { name: "Create" }).click();

		await vi.waitFor(() => {
			const call = vi
				.mocked(apiFetch)
				.mock.calls.find(
					([url, init]) =>
						typeof url === "string" &&
						url.endsWith("/taxonomies/tag/terms") &&
						init?.method === "POST",
				);
			expect(call).toBeDefined();
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toMatchObject({ label: "Internship Experience" });
			expect(body).not.toHaveProperty("slug");
		});
	});

	it("filters tags by label or slug without changing their stored order", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		const search = screen.getByRole("searchbox", { name: "Search tags" });
		const visibleOrder = () =>
			Array.from(
				document.querySelectorAll("tbody tr"),
				(row) => row.querySelector("td span")?.textContent,
			);

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Count", { exact: true })).toBeInTheDocument();
		expect(visibleOrder()).toEqual(["Technology", "Science"]);
		expect(screen.getByText("2 tags").query()).toBeNull();
		await search.fill("sci");
		await expect.element(screen.getByText("Science", { exact: true })).toBeInTheDocument();
		expect(screen.getByText("Technology", { exact: true }).query()).toBeNull();
		expect(screen.getByText("1 of 2 tags").query()).toBeNull();
		await screen.getByRole("button", { name: "More actions for Science" }).click();
		expect(screen.getByRole("menuitem", { name: "Move up Science" }).query()).toBeNull();
		await userEvent.keyboard("{Escape}");
		await search.fill("tech");
		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();
		expect(screen.getByText("Science", { exact: true }).query()).toBeNull();
		await search.fill("missing");
		await expect.element(screen.getByRole("table")).toBeInTheDocument();
		await expect.element(screen.getByText("Name", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("No matching tags")).toBeInTheDocument();
		screen.getByRole("button", { name: "Clear search" }).element().focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(search).toHaveFocus();
		await expect.element(screen.getByText("Science", { exact: true })).toBeInTheDocument();
		expect(visibleOrder()).toEqual(["Technology", "Science"]);
		expect(screen.getByText("2 tags").query()).toBeNull();
	});

	it("finds nested tags without showing unrelated siblings or losing ancestors", async () => {
		mockApiFetch(hierarchicalTermsResponse, undefined, hierarchicalTagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		const search = screen.getByRole("searchbox", { name: "Search tags" });

		await search.fill("Test child");
		await expect.element(screen.getByText("Design", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Test", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Test child", { exact: true })).toBeInTheDocument();
		expect(screen.getByText("Development", { exact: true }).query()).toBeNull();

		await search.fill("Design");
		await expect.element(screen.getByText("Design", { exact: true })).toBeInTheDocument();
		expect(screen.getByText("Test", { exact: true }).query()).toBeNull();
		expect(screen.getByText("Test child", { exact: true }).query()).toBeNull();
	});

	it("searches labels using the active content locale and announces result counts", async () => {
		manifestI18n = {
			defaultLocale: "tr",
			locales: ["tr", "en"],
		};
		mockApiFetch(turkishTermsResponse, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		const search = screen.getByRole("searchbox", { name: "Search tags" });
		const status = screen.getByRole("status");
		await expect.element(screen.getByRole("combobox", { name: "Locale" })).toHaveValue("tr");
		await expect.element(screen.getByText("İzin", { exact: true })).toBeInTheDocument();
		await search.fill("izin");
		await expect.element(screen.getByText("İzin", { exact: true })).toBeInTheDocument();
		await expect.element(status).toHaveTextContent("1 matching tag");
		await search.fill("indie");
		await expect.element(screen.getByText("Music", { exact: true })).toBeInTheDocument();
		await expect.element(status).toHaveTextContent("1 matching tag");
		await search.fill("missing");
		await expect.element(status).toHaveTextContent("0 matching tags");
	});

	it("does not crash on a configured locale that Intl cannot canonicalize", async () => {
		manifestI18n = { defaultLocale: "en-US-US", locales: ["en-US-US", "en"] };
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();
		await screen.getByRole("searchbox", { name: "Search tags" }).fill("tech");
		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();
	});

	it("keeps the leading slash of a tag slug in RTL", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const previousDirection = document.documentElement.dir;
		document.documentElement.dir = "rtl";
		try {
			const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
			await expect.element(screen.getByText("/tech", { exact: true })).toBeInTheDocument();
			expect(getComputedStyle(screen.getByText("/tech", { exact: true }).element()).direction).toBe(
				"ltr",
			);
		} finally {
			document.documentElement.dir = previousDirection;
		}
	});

	it("keeps tag editing visible and reorders from the row menu", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		await expect
			.element(screen.getByRole("button", { name: "Edit Technology" }))
			.toBeInTheDocument();
		await screen.getByRole("button", { name: "More actions for Technology" }).click();
		await expect
			.element(screen.getByRole("menuitem", { name: "Move up Technology" }))
			.toBeDisabled();
		await screen.getByRole("menuitem", { name: "Move down Technology" }).click();
		expect(reorderRequestBody()).toEqual({ parentId: null, ids: ["2", "1"] });
	});

	it("keeps deleting a tag behind its confirmation dialog", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();

		await screen.getByRole("button", { name: "More actions for Technology" }).click();
		await screen.getByRole("menuitem", { name: "Delete tag Technology" }).click();
		await expect.element(screen.getByText(DELETE_TECHNOLOGY_DESC_REGEX)).toBeInTheDocument();
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
		await expect.element(screen.getByRole("textbox", { name: "Slug" })).toBeInTheDocument();
		// The InputArea uses "Description (optional)" as label
		await expect.element(screen.getByText("Description (optional)")).toBeInTheDocument();
	});

	it("lets the server derive an auto-generated term slug", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		await screen.getByLabelText("Name").fill("音楽");
		await expect.element(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("音楽");

		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => {
			const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "POST");
			expect(call).toBeDefined();
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toMatchObject({ label: "音楽" });
			expect(body).not.toHaveProperty("slug");
		});
	});

	it("sends a manually edited term slug", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		await screen.getByLabelText("Name").fill("Music");
		await screen.getByRole("textbox", { name: "Slug" }).fill("custom-music");

		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => {
			const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "POST");
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toMatchObject({ label: "Music", slug: "custom-music" });
		});
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

	/** Parsed bodies of every reorder request, in the order they were sent. */
	function reorderRequestBodies(): unknown[] {
		return vi
			.mocked(apiFetch)
			.mock.calls.filter(([url]) => typeof url === "string" && url.includes("/reorder"))
			.map(([, init]) => (typeof init?.body === "string" ? JSON.parse(init.body) : undefined));
	}

	/** How many times the term list has been fetched. */
	function termFetchCount(): number {
		return vi
			.mocked(apiFetch)
			.mock.calls.filter(
				([url, init]) =>
					typeof url === "string" &&
					url.includes("/terms") &&
					!url.includes("/reorder") &&
					(!init || !init.method || init.method === "GET"),
			).length;
	}

	/**
	 * Labels of the rendered rows, top to bottom, read off each row's move
	 * button rather than the markup around it.
	 */
	function renderedOrder(): string[] {
		const buttons = document.querySelectorAll<HTMLElement>('button[aria-label$=" up"]');
		return Array.from(buttons, (button) =>
			(button.getAttribute("aria-label") ?? "").slice("Move ".length, -" up".length),
		);
	}

	it("moving a term sends the whole sibling group in its new order", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();

		await screen.getByRole("button", { name: "Move Technology down" }).click();

		expect(reorderRequestBody()).toEqual({ parentId: null, ids: ["2", "1"] });
	});

	it("moves the row on screen before the request comes back", async () => {
		const defer = deferReorders();
		mockApiFetch(undefined, defer);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();
		expect(renderedOrder()).toEqual(["Technology", "Science"]);

		await screen.getByRole("button", { name: "Move Technology down" }).click();

		// Still in flight, and the list has already moved.
		expect(defer.inFlight).toBe(1);
		expect(renderedOrder()).toEqual(["Science", "Technology"]);

		defer.release();
	});

	it("queues rapid moves and refetches once at the end", async () => {
		const defer = deferReorders();
		mockApiFetch(undefined, defer);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();
		const fetchesBefore = termFetchCount();

		// Two clicks before either response lands: down, then back up. The list
		// tracks both without waiting for the round trip.
		await screen.getByRole("button", { name: "Move Technology down" }).click();
		expect(renderedOrder()).toEqual(["Science", "Technology"]);
		await screen.getByRole("button", { name: "Move Technology up" }).click();
		expect(renderedOrder()).toEqual(["Technology", "Science"]);

		defer.release();
		await vi.waitFor(() => expect(reorderRequestBodies()).toHaveLength(2));

		// Each body is an absolute order taken from the list at click time, so
		// applying them in click order is what makes the last one win.
		expect(reorderRequestBodies()).toEqual([
			{ parentId: null, ids: ["2", "1"] },
			{ parentId: null, ids: ["1", "2"] },
		]);

		// Only the last of the queued moves refetches; an earlier one would serve
		// a stale order and snap the list back.
		expect(termFetchCount()).toBe(fetchesBefore + 1);
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

		// The label carries the reason: a disabled caret with no explanation is
		// two dead buttons on an arbitrary row.
		const up = screen.getByRole("button", {
			name: "Move Nino up — unavailable, its parent has no translation in this locale",
		});
		const down = screen.getByRole("button", {
			name: "Move Nino down — unavailable, its parent has no translation in this locale",
		});
		await expect.element(up).toBeDisabled();
		await expect.element(down).toBeDisabled();
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
