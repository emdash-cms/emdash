import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

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
	locale?: string;
	translationGroup?: string;
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
	locale: string;
	translationGroup: string;
}

interface TestUnresolvedAssignment {
	translationGroup: string;
	availableLocales: string[];
	translations: Array<{ id: string; slug: string; locale: string }>;
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
		locale: "en",
		translationGroup: id,
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

function requestUrl(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function mockApiFetch({
	taxonomies = [tagsTaxonomy],
	terms = [alphaTerm, betaTerm],
	entryTerms = [],
	createdTerm = makeTerm("term_created", "Gamma"),
	createError,
	unresolved = [],
}: {
	taxonomies?: TestTaxonomy[];
	terms?: TestTerm[];
	entryTerms?: TestTerm[];
	createdTerm?: TestTerm;
	createError?: string;
	unresolved?: TestUnresolvedAssignment[];
} = {}) {
	vi.mocked(apiFetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
		const urlString = requestUrl(url);
		const path = new URL(urlString, "http://localhost").pathname;
		const method = init?.method ?? "GET";

		if (method === "GET" && path === "/_emdash/api/taxonomies") {
			return dataResponse({ taxonomies });
		}

		if (method === "GET" && path === "/_emdash/api/taxonomies/tags/terms") {
			return dataResponse({ terms });
		}

		if (method === "GET" && path === "/_emdash/api/taxonomies/categories/terms") {
			return dataResponse({ terms });
		}

		if (method === "GET" && path === "/_emdash/api/content/products/entry_1/terms/tags") {
			return dataResponse({
				terms: entryTerms,
				unresolved,
				entryLocale: "fr",
				defaultLocale: "en",
				implicitDefaultLocale: false,
			});
		}

		if (method === "POST" && path === "/_emdash/api/taxonomies/tags/terms/nyusu/translations") {
			return dataResponse({ term: { ...alphaTerm, id: "term_fr", locale: "fr" } });
		}

		if (method === "POST" && path === "/_emdash/api/taxonomies/tags/terms") {
			if (createError) {
				return Promise.resolve(
					new Response(
						JSON.stringify({ error: { code: "TERM_CREATE_ERROR", message: createError } }),
						{ status: 500, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			return dataResponse({ term: createdTerm });
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
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByLabelText("Add Tags")).toBeInTheDocument();
		expect(screen.getByRole("option", { name: /^Alpha$/ }).query()).toBeNull();

		await screen.getByLabelText("Add Tags").click();

		await expect.element(screen.getByRole("option", { name: /^Alpha$/ })).toBeInTheDocument();
		await expect.element(screen.getByRole("option", { name: /^Beta$/ })).toBeInTheDocument();
	});

	it("opens existing terms when the tag picker receives keyboard focus", async () => {
		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });
		const input = screen.getByLabelText("Add Tags");

		await expect.element(input).toBeInTheDocument();
		await userEvent.tab();

		expect(document.activeElement).toBe(input.element());
		await expect.element(screen.getByRole("listbox")).toBeInTheDocument();
		await expect.element(screen.getByRole("option", { name: "Alpha" })).toBeInTheDocument();
	});

	it("filters flat taxonomy terms while preserving the create option for new input", async () => {
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});

		const input = screen.getByLabelText("Add Tags");
		await input.fill("Alp");

		await expect.element(screen.getByRole("option", { name: /^Alpha$/ })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: /^Beta$/ }).query()).toBeNull();
		await expect.element(screen.getByText('Create "Alp"')).toBeInTheDocument();
	});

	it("shows every match and ranks exact, prefix, then substring labels deterministically", async () => {
		mockApiFetch({
			terms: [
				makeTerm("term_web", "Web Security"),
				makeTerm("term_operations", "Security Operations"),
				makeTerm("term_cameras", "Security Cameras"),
				makeTerm("term_news", "Security News"),
				makeTerm("term_engineering", "Security Engineering"),
				makeTerm("term_compliance", "Security Compliance"),
				makeTerm("term_security", "Security"),
			],
		});

		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });
		await screen.getByLabelText("Add Tags").fill("security");

		const options = screen.getByRole("option").elements();
		expect(options.map((option) => option.textContent?.trim())).toEqual([
			"Security",
			"Security Cameras",
			"Security Compliance",
			"Security Engineering",
			"Security News",
			"Security Operations",
			"Web Security",
		]);
		expect(screen.getByText('Create "security"').query()).toBeNull();
	});

	it("uses accessible combobox and listbox semantics", async () => {
		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });

		const input = screen.getByRole("combobox", { name: "Add Tags" });
		await input.click();

		await expect.element(screen.getByRole("listbox")).toBeInTheDocument();
		await expect.element(screen.getByRole("option", { name: "Alpha" })).toBeInTheDocument();
		expect(input.element().getAttribute("aria-controls")).toBe(
			screen.getByRole("listbox").element().id,
		);
	});

	it("selects a result beyond the first five with a pointer", async () => {
		const onChange = vi.fn();
		mockApiFetch({
			terms: [
				...Array.from({ length: 11 }, (_, index) =>
					makeTerm(`term_${index + 1}`, `Security ${String(index + 1).padStart(2, "0")}`),
				),
				makeTerm("term_12", "Web Security"),
			],
		});

		const screen = await render(<TaxonomySidebar collection="products" onChange={onChange} />, {
			wrapper: Wrapper,
		});
		await screen.getByLabelText("Add Tags").fill("security");
		const listbox = screen.getByRole("listbox");
		const listboxElement = listbox.element();
		expect(listboxElement.scrollHeight).toBeGreaterThan(listboxElement.clientHeight);
		expect(listboxElement.scrollTop).toBe(0);

		await listbox.wheel({ delta: { y: 400 } });
		await vi.waitFor(() => expect(listboxElement.scrollTop).toBeGreaterThan(0));
		await screen.getByRole("option", { name: "Web Security" }).click();

		expect(onChange).toHaveBeenCalledWith("tags", ["term_12"]);
		await expect.element(screen.getByLabelText("Remove Web Security")).toBeInTheDocument();
	});

	it("navigates to and selects a later result with the keyboard", async () => {
		const onChange = vi.fn();
		mockApiFetch({
			terms: [
				makeTerm("term_security", "Security"),
				...Array.from({ length: 10 }, (_, index) =>
					makeTerm(`term_${index + 1}`, `Security ${String(index + 1).padStart(2, "0")}`),
				),
				makeTerm("term_web", "Web Security"),
			],
		});

		const screen = await render(<TaxonomySidebar collection="products" onChange={onChange} />, {
			wrapper: Wrapper,
		});
		await screen.getByLabelText("Add Tags").fill("security");
		const listbox = screen.getByRole("listbox").element();
		for (let index = 0; index < 11; index += 1) {
			await userEvent.keyboard("{ArrowDown}");
		}
		expect(listbox.scrollTop).toBeGreaterThan(0);
		await userEvent.keyboard("{Enter}");

		expect(onChange).toHaveBeenCalledWith("tags", ["term_web"]);
		await expect.element(screen.getByLabelText("Remove Web Security")).toBeInTheDocument();
	});

	it("wraps ArrowUp from the first result to the last result", async () => {
		const onChange = vi.fn();
		mockApiFetch({
			terms: [
				makeTerm("term_security", "Security"),
				makeTerm("term_news", "Security News"),
				makeTerm("term_web", "Web Security"),
			],
		});

		const screen = await render(<TaxonomySidebar collection="products" onChange={onChange} />, {
			wrapper: Wrapper,
		});
		await screen.getByLabelText("Add Tags").fill("security");
		await userEvent.keyboard("{ArrowUp}");
		await userEvent.keyboard("{Enter}");

		expect(onChange).toHaveBeenCalledWith("tags", ["term_web"]);
	});

	it("closes the suggestion list with Escape and keeps focus in the input", async () => {
		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });
		const input = screen.getByLabelText("Add Tags");
		await input.fill("a");
		await expect.element(screen.getByRole("listbox")).toBeInTheDocument();

		await userEvent.keyboard("{Escape}");

		expect(screen.getByRole("listbox").query()).toBeNull();
		expect(document.activeElement).toBe(input.element());
	});

	it("shows a folded exact match first and prevents duplicate creation", async () => {
		mockApiFetch({
			terms: [
				makeTerm("term_mexico_city", "Mexico City"),
				makeTerm("term_mexico_news", "Mexico News"),
				makeTerm("term_mexico_food", "Mexico Food"),
				makeTerm("term_mexico_travel", "Mexico Travel"),
				makeTerm("term_mexico_history", "Mexico History"),
				makeTerm("term_mexico", "México"),
			],
		});

		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });
		await screen.getByLabelText("Add Tags").fill("Mexico");

		expect(screen.getByRole("option").elements()[0]?.textContent?.trim()).toBe("México");
		expect(screen.getByText('Create "Mexico"').query()).toBeNull();
	});

	it("does not suggest terms already assigned to the entry", async () => {
		mockApiFetch({ entryTerms: [alphaTerm] });

		const screen = await render(
			<TaxonomySidebar collection="products" entryId="entry_1" canManageTaxonomies />,
			{ wrapper: Wrapper },
		);

		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
		await screen.getByLabelText("Add Tags").click();

		expect(screen.getByRole("option", { name: /^Alpha/ }).query()).toBeNull();
		await expect
			.element(screen.getByRole("option", { name: /^Beta.*EN fallback$/ }))
			.toBeInTheDocument();
	});

	it("keeps the create prompt available when no flat taxonomy terms exist", async () => {
		const onChange = vi.fn();
		mockApiFetch({ terms: [] });

		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies onChange={onChange} />,
			{
				wrapper: Wrapper,
			},
		);

		const input = screen.getByLabelText("Add Tags");
		await input.click();

		expect(screen.getByText('Create "Gamma"').query()).toBeNull();

		await input.fill("Gamma");

		await expect.element(screen.getByText('Create "Gamma"')).toBeInTheDocument();
		await screen.getByText('Create "Gamma"').click();

		await vi.waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				"/_emdash/api/taxonomies/tags/terms",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ label: "Gamma" }),
				}),
			);
		});
		expect(onChange).toHaveBeenCalledWith("tags", ["term_created"]);
	});

	it("lets the server derive the slug for an inline Unicode term", async () => {
		mockApiFetch({ terms: [] });
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});

		await screen.getByLabelText("Add Tags").fill("音楽");
		await screen.getByText('Create "音楽"').click();

		await vi.waitFor(() => {
			const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "POST");
			expect(call).toBeDefined();
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toEqual({ label: "音楽" });
		});
	});

	it("shows flat-term creation errors below the autocomplete", async () => {
		mockApiFetch({ terms: [], createError: "Term could not be created" });
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});

		await screen.getByLabelText("Add Tags").fill("Gamma");
		await screen.getByText('Create "Gamma"').click();

		await expect.element(screen.getByText("Term could not be created")).toBeInTheDocument();
	});

	it("continues to render hierarchical taxonomies as a checkbox tree", async () => {
		mockApiFetch({ taxonomies: [categoriesTaxonomy], terms: [alphaTerm] });

		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByText("Categories")).toBeInTheDocument();
		await expect.element(screen.getByText("Alpha")).toBeInTheDocument();
		expect(screen.getByLabelText("Add Categories").query()).toBeNull();
	});

	it("renders only the entry-locale definition for a translated taxonomy", async () => {
		mockApiFetch({
			taxonomies: [
				{ ...tagsTaxonomy, id: "tags-en", label: "Tags", locale: "en", translationGroup: "tags" },
				{
					...tagsTaxonomy,
					id: "tags-de",
					label: "Schlagwörter",
					locale: "de",
					translationGroup: "tags",
				},
				{
					...tagsTaxonomy,
					id: "tags-fr",
					label: "Étiquettes",
					locale: "fr",
					translationGroup: "tags",
				},
			],
		});

		const screen = await render(
			<TaxonomySidebar
				collection="products"
				entryLocale="de"
				defaultLocale="en"
				canManageTaxonomies
			/>,
			{ wrapper: Wrapper },
		);

		await expect.element(screen.getByText("Schlagwörter", { exact: true })).toBeInTheDocument();
		expect(screen.getByText("Tags").query()).toBeNull();
		expect(screen.getByText("Étiquettes").query()).toBeNull();
		await expect.element(screen.getByLabelText("Add Schlagwörter")).toBeInTheDocument();
	});

	it("selects Arabic matches when the interface direction is RTL", async () => {
		const previousDirection = document.documentElement.dir;
		document.documentElement.dir = "rtl";
		const onChange = vi.fn();
		mockApiFetch({
			terms: [
				makeTerm("term_network", "أمن الشبكات"),
				makeTerm("term_information", "أمن المعلومات"),
				makeTerm("term_cloud", "الأمن السحابي"),
			],
		});

		try {
			const screen = await render(<TaxonomySidebar collection="products" onChange={onChange} />, {
				wrapper: Wrapper,
			});
			await screen.getByLabelText("Add Tags").fill("أمن");

			const listbox = screen.getByRole("listbox");
			await expect.element(listbox).toBeInTheDocument();
			await screen.getByRole("option", { name: "أمن المعلومات" }).click();

			expect(onChange).toHaveBeenCalledWith("tags", ["term_information"]);
		} finally {
			document.documentElement.dir = previousDirection;
		}
	});

	it("shows the actual locale when a selected term uses the default fallback", async () => {
		mockApiFetch({ entryTerms: [alphaTerm] });

		const screen = await render(
			<TaxonomySidebar
				collection="products"
				entryId="entry_1"
				entryLocale="fr"
				canManageTaxonomies
			/>,
			{ wrapper: Wrapper },
		);

		await expect.element(screen.getByText("EN fallback")).toBeInTheDocument();
	});

	it("labels fallback terms in flat suggestions before selection", async () => {
		const screen = await render(
			<TaxonomySidebar
				collection="products"
				entryId="entry_1"
				entryLocale="fr"
				canManageTaxonomies
			/>,
			{ wrapper: Wrapper },
		);

		await screen.getByLabelText("Add Tags").click();
		await expect
			.element(screen.getByRole("option", { name: /^Alpha.*EN fallback$/ }))
			.toBeInTheDocument();
	});

	it("keeps unresolved groups visible and preserves them when another term is assigned", async () => {
		mockApiFetch({
			unresolved: [
				{
					translationGroup: "group_ja",
					availableLocales: ["ja"],
					translations: [{ id: "term_ja", slug: "nyusu", locale: "ja" }],
				},
			],
		});

		const screen = await render(
			<TaxonomySidebar
				collection="products"
				entryId="entry_1"
				entryLocale="fr"
				canManageTaxonomies
			/>,
			{ wrapper: Wrapper },
		);

		await expect.element(screen.getByText("Unresolved assignment")).toBeInTheDocument();
		await expect.element(screen.getByText("Available in JA")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Create FR translation" }))
			.toBeInTheDocument();

		await screen.getByLabelText("Add Tags").click();
		await screen.getByRole("option", { name: /^Beta.*EN fallback$/ }).click();

		await vi.waitFor(() => {
			const save = vi
				.mocked(apiFetch)
				.mock.calls.find(
					([url, init]) =>
						requestUrl(url).includes("/content/products/entry_1/terms/tags") &&
						init?.method === "POST",
				);
			expect(save).toBeDefined();
			if (!save) throw new Error("Expected an entry-terms save request");
			expect(requestUrl(save[0])).not.toContain("locale=");
			const body = save?.[1]?.body;
			expect(typeof body).toBe("string");
			if (typeof body !== "string") throw new Error("Expected a JSON request body");
			expect(JSON.parse(body)).toEqual({
				termIds: expect.arrayContaining(["term_beta", "term_ja"]),
			});
		});
	});

	it("requests exact/default resolution for the entry-locale picker", async () => {
		const screen = await render(
			<TaxonomySidebar
				collection="products"
				entryId="entry_1"
				entryLocale="fr"
				canManageTaxonomies
			/>,
			{ wrapper: Wrapper },
		);
		await expect.element(screen.getByLabelText("Add Tags")).toBeInTheDocument();

		const termListCall = vi
			.mocked(apiFetch)
			.mock.calls.find(([url]) => requestUrl(url).includes("/taxonomies/tags/terms"));
		expect(termListCall).toBeDefined();
		if (!termListCall) throw new Error("Expected a taxonomy term-list request");
		expect(requestUrl(termListCall[0])).toContain("resolveFallback=true");

		const entryTermsCall = vi
			.mocked(apiFetch)
			.mock.calls.find(([url]) => requestUrl(url).includes("/content/products/entry_1/terms/tags"));
		expect(entryTermsCall).toBeDefined();
		if (!entryTermsCall) throw new Error("Expected an entry-terms request");
		expect(requestUrl(entryTermsCall[0])).not.toContain("locale=");
	});

	it("hides flat-term and translation creation without taxonomy management permission", async () => {
		mockApiFetch({
			unresolved: [
				{
					translationGroup: "group_ja",
					availableLocales: ["ja"],
					translations: [{ id: "term_ja", slug: "nyusu", locale: "ja" }],
				},
			],
		});
		const screen = await render(
			<TaxonomySidebar
				collection="products"
				entryId="entry_1"
				entryLocale="fr"
				canManageTaxonomies={false}
			/>,
			{ wrapper: Wrapper },
		);

		await expect.element(screen.getByText("Unresolved assignment")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create FR translation" }).query()).toBeNull();
		await screen.getByLabelText("Add Tags").fill("Gamma");
		expect(screen.getByText('Create "Gamma"').query()).toBeNull();
	});

	it("hides hierarchical term creation without taxonomy management permission", async () => {
		mockApiFetch({ taxonomies: [categoriesTaxonomy], terms: [alphaTerm] });
		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies={false} />,
			{ wrapper: Wrapper },
		);

		await expect.element(screen.getByText("Categories")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add new category" }).query()).toBeNull();
	});
});
