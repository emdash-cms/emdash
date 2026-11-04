import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
	getAvailableParentTerms,
	replaceSiblingGroup,
	reorderWithinSlots,
	TaxonomyManager,
} from "../../src/components/TaxonomyManager";
import type { TaxonomyTerm } from "../../src/lib/api/taxonomies.js";

import "../../dist/styles.css";
import { pressOutside } from "../utils/mouse.ts";
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

const topicsTaxonomyResponse = JSON.stringify({
	data: {
		taxonomies: [
			{
				id: "topics",
				name: "topics",
				label: "Schlagwörter",
				hierarchical: false,
				collections: ["posts"],
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

const singleTermResponse = JSON.stringify({
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
		],
	},
});

const termsWithDescriptionResponse = JSON.stringify({
	data: {
		terms: [
			{
				id: "1",
				name: "tech",
				slug: "tech",
				label: "Technology",
				parentId: null,
				description: "Previously saved description",
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

const clothingTermsResponse = JSON.stringify({
	data: {
		terms: [
			{
				id: "men",
				name: "categories",
				slug: "men",
				label: "Men",
				parentId: null,
				translationGroup: "men-group",
				children: [
					{
						id: "men-accessories",
						name: "categories",
						slug: "accessories",
						label: "Accessories",
						parentId: "men-group",
						translationGroup: "men-accessories-group",
						children: [],
						count: 0,
					},
				],
				count: 0,
			},
			{
				id: "women",
				name: "categories",
				slug: "women",
				label: "Women",
				parentId: null,
				translationGroup: "women-group",
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
const TAKEN_TERM_SLUG = "Another term already uses this slug. Enter a different one.";
const TAKEN_TAXONOMY_NAME = "Another taxonomy already uses this name. Enter a different one.";
const NAME_NOT_GENERATED =
	"A name cannot be generated from this label. Type one manually using lowercase letters, numbers, and underscores.";

function conflictResponse(message: string) {
	return new Response(JSON.stringify({ error: { code: "CONFLICT", message } }), {
		status: 409,
		headers: { "Content-Type": "application/json" },
	});
}

function requestsWith(method: string, path: string) {
	return vi
		.mocked(apiFetch)
		.mock.calls.filter(
			([url, init]) => typeof url === "string" && url.includes(path) && init?.method === method,
		);
}
const EDIT_TERM_REGEX = /^Edit /;

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
		const slugHelp = screen.getByRole("tooltip", {
			name: "Auto-generated from name (you can edit)",
		});
		expect(slugHelp.query()).toBeNull();

		await screen.getByRole("button", { name: "How is the slug generated?" }).hover();
		await expect.element(slugHelp).toBeVisible();
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
			expect(body).toMatchObject({
				label: "Internship Experience",
				slug: "internship-experience",
			});
		});
		await expect.element(screen.getByText("Term created")).toBeVisible();
	});

	it("opens an empty form after creating a tag without leaving the page", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		await screen.getByRole("button", { name: "Add tag" }).click();
		await screen.getByRole("textbox", { name: "Name" }).fill("Internship Experience");
		await expect
			.element(screen.getByRole("textbox", { name: "Slug" }))
			.toHaveValue("internship-experience");
		await screen.getByRole("dialog").getByRole("button", { name: "Create" }).click();
		await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Add tag" }).click();
		await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
		await expect.element(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("");
	});

	it.each(["Create", "Cancel", "Escape"])("resets every create field after %s", async (action) => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		await screen.getByRole("textbox", { name: "Name" }).fill("Music");
		await screen.getByRole("textbox", { name: "Slug" }).fill("custom-music");
		await screen.getByRole("textbox", { name: "Description (optional)" }).fill("Music news");
		await screen.getByRole("combobox", { name: "Parent" }).click();
		await screen.getByRole("option", { name: "Technology" }).click();
		if (action === "Escape") {
			await userEvent.keyboard("{Escape}");
		} else {
			await screen.getByRole("dialog").getByRole("button", { name: action, exact: true }).click();
		}
		await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();

		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
		await expect.element(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("");
		await expect
			.element(screen.getByRole("textbox", { name: "Description (optional)" }))
			.toHaveValue("");
		await expect
			.element(screen.getByRole("combobox", { name: "Parent" }))
			.toHaveTextContent("None (top level)");
		await screen.getByRole("textbox", { name: "Name" }).fill("New term");
		await expect.element(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("new-term");
	});

	it("preserves a failed create for retry but clears its values and error on reopening", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		await screen.getByRole("textbox", { name: "Name" }).fill("Music");
		await screen.getByRole("textbox", { name: "Slug" }).fill("custom-music");
		vi.mocked(apiFetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { message: "Term already exists" } }), {
				status: 409,
				headers: { "Content-Type": "application/json" },
			}),
		);
		await screen.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
		await expect.element(screen.getByText("Term already exists")).toBeVisible();
		await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Music");
		await expect.element(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("custom-music");
		await screen.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
		await expect.element(screen.getByText("Term already exists")).not.toBeInTheDocument();
	});

	it("reloads saved values after cancelling an edit of the same term", async () => {
		mockApiFetch(termsWithDescriptionResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: "Edit Technology", exact: true }).click();
		await screen.getByRole("textbox", { name: "Name" }).fill("Unsaved name");
		await screen
			.getByRole("textbox", { name: "Description (optional)" })
			.fill("Unsaved description");
		await screen.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Edit Technology", exact: true }).click();
		await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Technology");
		await expect.element(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("tech");
		await expect
			.element(screen.getByRole("textbox", { name: "Description (optional)" }))
			.toHaveValue("Previously saved description");
		await screen.getByRole("textbox", { name: "Name" }).fill("New name");
		await expect.element(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("tech");
	});

	it("filters tags by label or slug without changing their stored order", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		const search = screen.getByRole("searchbox", { name: "Search tags" });

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Count", { exact: true })).toBeInTheDocument();
		expect(renderedOrder()).toEqual(["Technology", "Science"]);
		expect(screen.getByText("2 tags").query()).toBeNull();
		await search.fill("sci");
		await expect.element(screen.getByText("Science", { exact: true })).toBeInTheDocument();
		expect(screen.getByText("Technology", { exact: true }).query()).toBeNull();
		expect(screen.getByText("1 of 2 tags").query()).toBeNull();
		const menu = await openRowMenu("Science");
		expect(menu.getByRole("menuitem", { name: "Move up" }).query()).toBeNull();
		expect(menu.getByRole("menuitem", { name: "Move down" }).query()).toBeNull();
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
		expect(renderedOrder()).toEqual(["Technology", "Science"]);
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
			.element(screen.getByRole("button", { name: "Edit Technology", exact: true }))
			.toHaveTextContent("Technology");
		const menu = await openRowMenu("Technology");
		await expect.element(menu.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
		await menu.getByRole("menuitem", { name: "Move down" }).click();
		expect(reorderRequestBody()).toEqual({ parentId: null, ids: ["2", "1"] });
	});

	it("keeps deleting a tag behind its confirmation dialog", async () => {
		mockApiFetch(undefined, undefined, tagTaxonomyResponse);
		const screen = await render(<TaxonomyManager taxonomyName="tag" />, { wrapper: Wrapper });
		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();

		await deleteFromRowMenu("Technology");
		await expect.element(screen.getByText(DELETE_TECHNOLOGY_DESC_REGEX)).toBeInTheDocument();
	});

	it("shows list of terms with labels", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Science", { exact: true })).toBeInTheDocument();
	});

	it("shows each term's slug under its name", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		for (const [label, slug] of [
			["Technology", "/tech"],
			["Science", "/science"],
		] as const) {
			const slugText = screen.getByText(slug, { exact: true });
			await expect.element(slugText).toBeVisible();
			const name = screen.getByRole("button", { name: `Edit ${label}`, exact: true }).element();
			expect(slugText.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(
				name.getBoundingClientRect().bottom,
			);
		}
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

	it("sends the auto-generated term slug the form shows", async () => {
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
			expect(body).toMatchObject({ label: "音楽", slug: "音楽" });
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

	it("shows and sends a free slug when a name repeats under another parent", async () => {
		mockApiFetch(clothingTermsResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		const dialog = screen.getByRole("dialog");
		await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Accessories");
		await dialog.getByRole("combobox", { name: "Parent" }).click();
		await screen.getByRole("option", { name: "Women", exact: true }).click();

		await expect
			.element(dialog.getByRole("textbox", { name: "Slug", exact: true }))
			.toHaveValue("accessories-1");
		await dialog.getByRole("button", { name: "Create", exact: true }).click();

		await vi.waitFor(() => {
			const call = requestsWith("POST", "/terms")[0];
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toMatchObject({
				label: "Accessories",
				slug: "accessories-1",
				parentId: "women-group",
			});
		});
	});

	it("sends a typed slug longer than a generated one", async () => {
		const longSlug = `${"long-".repeat(17)}slug`;
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		const dialog = screen.getByRole("dialog");
		await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Long");
		await dialog.getByRole("textbox", { name: "Slug", exact: true }).fill(longSlug);
		await dialog.getByRole("button", { name: "Create", exact: true }).click();

		await vi.waitFor(() => {
			const call = requestsWith("POST", "/terms")[0];
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toMatchObject({ label: "Long", slug: longSlug });
		});
	});

	it("points at a missing term name when submitted, and sends nothing", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		const dialog = screen.getByRole("dialog");
		const name = dialog.getByRole("textbox", { name: "Name", exact: true });
		await dialog.getByRole("button", { name: "Create", exact: true }).click();

		await expect.element(dialog.getByText("Enter a name.")).toBeVisible();
		await expect.element(name).toHaveAttribute("aria-invalid", "true");
		await expect.element(name).toHaveFocus();
		await expect
			.element(dialog.getByRole("textbox", { name: "Slug", exact: true }))
			.not.toHaveAttribute("aria-invalid");
		expect(requestsWith("POST", "/terms")).toHaveLength(0);

		await name.fill("Music");
		await expect.element(dialog.getByText("Enter a name.")).not.toBeInTheDocument();
	});

	it("points at a cleared slug when editing a term, and sends nothing", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: "Edit Technology", exact: true }).click();
		const dialog = screen.getByRole("dialog");
		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });
		await slug.fill("");
		await dialog.getByRole("button", { name: "Update" }).click();

		await expect.element(dialog.getByText("Enter a slug.")).toBeVisible();
		await expect.element(slug).toHaveAttribute("aria-invalid", "true");
		await expect.element(slug).toHaveFocus();
		expect(requestsWith("PUT", "/terms/")).toHaveLength(0);
	});

	it("sends a typed slug as typed, even one the form would not generate", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		const dialog = screen.getByRole("dialog");
		await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Archive");
		await dialog.getByRole("textbox", { name: "Slug", exact: true }).fill("Archive_2024");
		await dialog.getByRole("button", { name: "Create", exact: true }).click();

		await vi.waitFor(() => {
			const call = requestsWith("POST", "/terms")[0];
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toMatchObject({ label: "Archive", slug: "Archive_2024" });
		});
	});

	it("still saves a term whose stored slug the form would not generate", async () => {
		mockApiFetch(turkishTermsResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: "Edit Music", exact: true }).click();
		const dialog = screen.getByRole("dialog");
		await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Indie music");
		await dialog.getByRole("button", { name: "Update" }).click();

		await vi.waitFor(() => {
			const call = requestsWith("PUT", "/terms/INDIE")[0];
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toMatchObject({ slug: "INDIE", label: "Indie music" });
		});
	});

	it("shows a slug another term uses on the Slug field", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		const dialog = screen.getByRole("dialog");
		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });
		await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Tech");
		await slug.fill("tech");
		vi.mocked(apiFetch).mockResolvedValueOnce(
			conflictResponse("Term 'tech' already exists in 'categories' (en)"),
		);
		await dialog.getByRole("button", { name: "Create", exact: true }).click();

		await expect.element(dialog.getByText(TAKEN_TERM_SLUG)).toBeVisible();
		await expect.element(slug).toHaveFocus();
		await expect.element(slug).toHaveAttribute("aria-invalid", "true");
		expect(dialog.getByText("Term 'tech' already exists in 'categories' (en)").query()).toBeNull();

		await slug.fill("tech-news");
		await expect.element(dialog.getByText(TAKEN_TERM_SLUG)).not.toBeInTheDocument();
	});

	it("reports a refused slug in the banner when the slug changed during the save", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		const dialog = screen.getByRole("dialog");
		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });
		await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Tech");
		await slug.fill("tech");
		let refuse!: () => void;
		vi.mocked(apiFetch).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					refuse = () =>
						resolve(conflictResponse("Term 'tech' already exists in 'categories' (en)"));
				}),
		);
		await dialog.getByRole("button", { name: "Create", exact: true }).click();
		await expect.element(dialog.getByRole("button", { name: "Saving..." })).toBeVisible();
		await slug.fill("tech-news");
		refuse();

		await expect
			.element(dialog.getByText("Term 'tech' already exists in 'categories' (en)"))
			.toBeVisible();
		await expect.element(slug).not.toHaveAttribute("aria-invalid");
	});

	it("keeps a typed term through a press outside, and closes an untouched form", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		const dialog = screen.getByRole("dialog");
		await expect.element(dialog).toBeVisible();
		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();

		await screen.getByRole("button", { name: ADD_CATEGORY_BUTTON_REGEX }).click();
		await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Music");
		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect
			.element(dialog.getByRole("textbox", { name: "Name", exact: true }))
			.toHaveValue("Music");
	});

	it("points at a missing taxonomy label when submitted, and sends nothing", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: "New Taxonomy" }).click();
		const dialog = screen.getByRole("dialog", { name: "Create Taxonomy" });
		const label = dialog.getByRole("textbox", { name: "Label", exact: true });
		await dialog.getByRole("button", { name: "Create Taxonomy" }).click();

		await expect.element(dialog.getByText("Enter a label.")).toBeVisible();
		await expect.element(label).toHaveAttribute("aria-invalid", "true");
		await expect.element(label).toHaveFocus();
		await expect
			.element(dialog.getByRole("textbox", { name: "Name", exact: true }))
			.not.toHaveAttribute("aria-invalid");
		expect(requestsWith("POST", "/taxonomies")).toHaveLength(0);
	});

	it("explains a taxonomy name it cannot generate, then points at it on submit", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: "New Taxonomy" }).click();
		const dialog = screen.getByRole("dialog", { name: "Create Taxonomy" });
		const name = dialog.getByRole("textbox", { name: "Name", exact: true });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("أنواع");

		await expect.element(dialog.getByText(NAME_NOT_GENERATED)).toBeVisible();
		await expect.element(name).not.toHaveAttribute("aria-invalid");

		await dialog.getByRole("button", { name: "Create Taxonomy" }).click();
		await expect.element(name).toHaveAttribute("aria-invalid", "true");
		await expect.element(name).toHaveFocus();
		await expect.element(dialog.getByText(NAME_NOT_GENERATED)).toBeVisible();

		await name.fill("Kinds");
		await expect
			.element(
				dialog.getByText(
					"Use lowercase letters, numbers, and underscores, starting with a letter.",
				),
			)
			.toBeVisible();
		expect(requestsWith("POST", "/taxonomies")).toHaveLength(0);
	});

	it("shows a name another taxonomy uses on the Name field", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: "New Taxonomy" }).click();
		const dialog = screen.getByRole("dialog", { name: "Create Taxonomy" });
		const name = dialog.getByRole("textbox", { name: "Name", exact: true });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Categories");
		await expect.element(name).toHaveValue("categories");
		vi.mocked(apiFetch).mockResolvedValueOnce(
			conflictResponse("Taxonomy 'categories' already exists in locale 'en'"),
		);
		await dialog.getByRole("button", { name: "Create Taxonomy" }).click();

		await expect.element(dialog.getByText(TAKEN_TAXONOMY_NAME)).toBeVisible();
		await expect.element(name).toHaveFocus();
		expect(
			dialog.getByText("Taxonomy 'categories' already exists in locale 'en'").query(),
		).toBeNull();

		await name.fill("genres");
		await expect.element(dialog.getByText(TAKEN_TAXONOMY_NAME)).not.toBeInTheDocument();
	});

	it("reports a refused name in the banner when the name changed during the save", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: "New Taxonomy" }).click();
		const dialog = screen.getByRole("dialog", { name: "Create Taxonomy" });
		const name = dialog.getByRole("textbox", { name: "Name", exact: true });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Categories");
		await expect.element(name).toHaveValue("categories");
		let refuse!: () => void;
		vi.mocked(apiFetch).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					refuse = () =>
						resolve(conflictResponse("Taxonomy 'categories' already exists in locale 'en'"));
				}),
		);
		await dialog.getByRole("button", { name: "Create Taxonomy" }).click();
		await expect.element(dialog.getByRole("button", { name: "Creating..." })).toBeVisible();
		await name.fill("genres");
		refuse();

		await expect
			.element(dialog.getByText("Taxonomy 'categories' already exists in locale 'en'"))
			.toBeVisible();
		await expect.element(name).not.toHaveAttribute("aria-invalid");
	});

	it("keeps a typed taxonomy through a press outside, and closes an untouched form", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await screen.getByRole("button", { name: "New Taxonomy" }).click();
		const dialog = screen.getByRole("dialog", { name: "Create Taxonomy" });
		await expect.element(dialog).toBeVisible();
		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "New Taxonomy" }).click();
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Genres");
		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect
			.element(dialog.getByRole("textbox", { name: "Label", exact: true }))
			.toHaveValue("Genres");
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

	it("opens the term editor from the row menu's Edit item", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		const menu = await openRowMenu("Technology");
		await menu.getByRole("menuitem", { name: "Edit", exact: true }).click();

		await expect
			.element(screen.getByRole("heading", { name: EDIT_CATEGORY_HEADING_REGEX }))
			.toBeInTheDocument();
		await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Technology");
	});

	it("opens the translate dialog from the row menu on a site with two locales", async () => {
		manifestI18n = { defaultLocale: "en", locales: ["en", "de"] };
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});
		await expect.element(screen.getByRole("combobox", { name: "Locale" })).toBeVisible();

		const menu = await openRowMenu("Technology");
		await menu.getByRole("menuitem", { name: "Translate", exact: true }).click();

		await expect
			.element(screen.getByRole("heading", { name: 'Translate "Technology"', exact: true }))
			.toBeInTheDocument();
	});

	it('sends description: "" when the description field is cleared in the edit dialog', async () => {
		mockApiFetch(termsWithDescriptionResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Edit Technology" }).click();

		const descInput = screen.getByPlaceholder("Optional description");
		await expect.element(descInput).toHaveValue("Previously saved description");
		await descInput.fill("");

		await screen.getByRole("button", { name: "Update" }).click();

		await vi.waitFor(() => {
			const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "PUT");
			expect(call).toBeDefined();
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toMatchObject({ slug: "tech", label: "Technology", description: "" });
		});
	});

	it("delete button opens confirm dialog", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();

		await deleteFromRowMenu("Technology");

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

	/** Labels of the rendered rows, top to bottom, read off each term's name button. */
	function renderedOrder(): string[] {
		return page
			.getByRole("button", { name: EDIT_TERM_REGEX })
			.elements()
			.map((button) => button.textContent ?? "");
	}

	async function openRowMenu(label: string) {
		await page.getByRole("button", { name: `Actions for ${label}`, exact: true }).click();
		const menu = page.getByRole("menu");
		await expect.element(menu).toBeVisible();
		return menu;
	}

	/** Moves a term from the keyboard, which should leave focus on the moved row's menu button. */
	async function moveFromRowMenu(label: string, item: "Move up" | "Move down") {
		// A pointer left resting over the menu stops Base UI returning focus to the trigger.
		await page.getByRole("heading", { level: 1 }).hover();
		const trigger = page.getByRole("button", { name: `Actions for ${label}`, exact: true });
		trigger.element().focus();
		await userEvent.keyboard("{Enter}");
		const menu = page.getByRole("menu");
		await expect.element(menu.getByRole("menuitem", { name: "Edit", exact: true })).toHaveFocus();
		await userEvent.keyboard(item === "Move up" ? "{ArrowDown}" : "{ArrowDown}{ArrowDown}");
		await expect.element(menu.getByRole("menuitem", { name: item })).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect.element(menu).not.toBeInTheDocument();
		await expect.element(trigger).toHaveFocus();
	}

	async function deleteFromRowMenu(label: string) {
		const menu = await openRowMenu(label);
		await menu.getByRole("menuitem", { name: `Delete ${label}`, exact: true }).click();
	}

	it("moving a term sends the whole sibling group in its new order", async () => {
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();

		await moveFromRowMenu("Technology", "Move down");

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

		await moveFromRowMenu("Technology", "Move down");

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

		// Two moves before either response lands: down, then back up. The list
		// tracks both without waiting for the round trip.
		await moveFromRowMenu("Technology", "Move down");
		expect(renderedOrder()).toEqual(["Science", "Technology"]);
		await moveFromRowMenu("Technology", "Move up");
		expect(renderedOrder()).toEqual(["Technology", "Science"]);

		defer.release();
		await vi.waitFor(() => expect(reorderRequestBodies()).toHaveLength(2));

		// Each body is an absolute order taken from the list at move time, so
		// applying them in move order is what makes the last one win.
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

		const first = await openRowMenu("Technology");
		await expect.element(first.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
		await expect.element(first.getByRole("menuitem", { name: "Move down" })).toBeEnabled();
		await userEvent.keyboard("{Escape}");
		await expect.element(first).not.toBeInTheDocument();

		const last = await openRowMenu("Science");
		await expect.element(last.getByRole("menuitem", { name: "Move up" })).toBeEnabled();
		await expect.element(last.getByRole("menuitem", { name: "Move down" })).toBeDisabled();
	});

	it("reorders the top level while nested rows are on screen", async () => {
		mockApiFetch(hierarchicalTermsResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Test", { exact: true })).toBeInTheDocument();

		await moveFromRowMenu("Design", "Move down");

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

		await moveFromRowMenu("Fonts", "Move down");

		expect(reorderRequestBody()).toEqual({
			parentId: "design-group",
			ids: ["colour-group", "fonts-group"],
		});
	});

	it.each([
		["an only child", hierarchicalTermsResponse, "Test"],
		["the only root", singleTermResponse, "Technology"],
	])("leaves Move out of the menu for %s", async (_case, response, label) => {
		mockApiFetch(response);
		await render(<TaxonomyManager taxonomyName="categories" />, { wrapper: Wrapper });

		const menu = await openRowMenu(label);
		await expect.element(menu.getByRole("menuitem", { name: "Edit", exact: true })).toBeVisible();
		expect(menu.getByRole("menuitem", { name: "Move up" }).query()).toBeNull();
		expect(menu.getByRole("menuitem", { name: "Move down" }).query()).toBeNull();
	});

	it("cannot move a term whose parent is untranslated", async () => {
		mockApiFetch(untranslatedParentTermsResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Nino", { exact: true })).toBeInTheDocument();

		const reason =
			"Nino can't be moved here — its parent has no translation in this locale, so this list isn't the group it belongs to.";
		const menu = await openRowMenu("Nino");
		await expect.element(menu.getByText(reason, { exact: true })).toBeVisible();
		const moves = menu.getByRole("group", { name: reason });
		for (const name of ["Move up", "Move down"]) {
			const item = moves.getByRole("menuitem", { name });
			await expect.element(item).toBeDisabled();
			await expect.element(item).toHaveAccessibleDescription(reason);
		}
	});

	it("leaves an untranslated-parent term out of the group it is drawn in", async () => {
		mockApiFetch(untranslatedParentTermsResponse);
		const screen = await render(<TaxonomyManager taxonomyName="categories" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Gamma", { exact: true })).toBeInTheDocument();

		// Beta and Gamma are the only real roots, so Beta's "down" is enabled even
		// though Nino sits between them, and Nino is not named in the request.
		await moveFromRowMenu("Beta", "Move down");

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

	it("keeps the taxonomy label capitalized and falls back to the translated Term for a German admin", async () => {
		mockApiFetch(JSON.stringify({ data: { terms: [] } }), undefined, topicsTaxonomyResponse);
		const previousLocale = i18n.locale;
		i18n.load("de", { [msg`Term`.id!]: "Begriff" });
		i18n.activate("de");

		try {
			const screen = await render(<TaxonomyManager taxonomyName="topics" />, { wrapper: Wrapper });
			await expect
				.element(screen.getByText("Manage Schlagwörter for posts", { exact: true }))
				.toBeInTheDocument();
			await expect
				.element(
					screen.getByText("No Schlagwörter yet. Create one to get started.", { exact: true }),
				)
				.toBeInTheDocument();

			await screen.getByRole("button", { name: "Add Begriff", exact: true }).click();
			await expect
				.element(screen.getByText("Create a new Begriff", { exact: true }))
				.toBeInTheDocument();
		} finally {
			i18n.activate(previousLocale);
		}
	});

	it("titles the delete confirmation with the translated Term for a taxonomy without a singular label", async () => {
		mockApiFetch(undefined, undefined, topicsTaxonomyResponse);
		const previousLocale = i18n.locale;
		i18n.load("de", { [msg`Term`.id!]: "Begriff" });
		i18n.activate("de");

		try {
			const screen = await render(<TaxonomyManager taxonomyName="topics" />, { wrapper: Wrapper });
			await expect.element(screen.getByText("Technology", { exact: true })).toBeInTheDocument();

			await deleteFromRowMenu("Technology");
			await expect
				.element(screen.getByRole("heading", { name: "Delete Begriff?", exact: true }))
				.toBeInTheDocument();
		} finally {
			i18n.activate(previousLocale);
		}
	});
});
