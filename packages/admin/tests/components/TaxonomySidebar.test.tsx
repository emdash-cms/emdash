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

type TestTermMutationResponse = Omit<TestTerm, "children"> & {
	children?: TestTerm[];
};

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
	createErrorFor,
	createTermRequest,
	unresolved = [],
	saveEntryTerms,
}: {
	taxonomies?: TestTaxonomy[];
	terms?: TestTerm[];
	entryTerms?: TestTerm[];
	createdTerm?: TestTermMutationResponse;
	createError?: string;
	createErrorFor?: string;
	createTermRequest?: (label: string) => Promise<Response>;
	unresolved?: TestUnresolvedAssignment[];
	saveEntryTerms?: (init?: RequestInit) => Promise<Response>;
} = {}) {
	let currentTerms = terms;
	vi.mocked(apiFetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
		const urlString = requestUrl(url);
		const path = new URL(urlString, "http://localhost").pathname;
		const method = init?.method ?? "GET";

		if (method === "GET" && path === "/_emdash/api/taxonomies") {
			return dataResponse({ taxonomies });
		}

		if (method === "GET" && path === "/_emdash/api/taxonomies/tags/terms") {
			return dataResponse({ terms: currentTerms });
		}

		if (method === "GET" && path === "/_emdash/api/taxonomies/categories/terms") {
			return dataResponse({ terms: currentTerms });
		}

		if (
			method === "GET" &&
			(path === "/_emdash/api/content/products/entry_1/terms/tags" ||
				path === "/_emdash/api/content/products/entry_1/terms/categories")
		) {
			return dataResponse({
				terms: entryTerms,
				unresolved,
				entryLocale: "fr",
				defaultLocale: "en",
				implicitDefaultLocale: false,
			});
		}

		if (
			method === "POST" &&
			(path === "/_emdash/api/content/products/entry_1/terms/tags" ||
				path === "/_emdash/api/content/products/entry_1/terms/categories")
		) {
			return saveEntryTerms?.(init) ?? dataResponse({});
		}

		if (method === "POST" && path === "/_emdash/api/taxonomies/tags/terms/nyusu/translations") {
			return dataResponse({ term: { ...alphaTerm, id: "term_fr", locale: "fr" } });
		}

		if (
			method === "POST" &&
			(path === "/_emdash/api/taxonomies/tags/terms" ||
				path === "/_emdash/api/taxonomies/categories/terms")
		) {
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
			const requestedLabel =
				body && typeof body === "object" && "label" in body ? body.label : undefined;
			if (typeof requestedLabel === "string" && createTermRequest) {
				return createTermRequest(requestedLabel);
			}
			if (createError || requestedLabel === createErrorFor) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error: {
								code: "TERM_CREATE_ERROR",
								message: createError ?? `Could not create ${String(requestedLabel)}`,
							},
						}),
						{ status: 500, headers: { "Content-Type": "application/json" } },
					),
				);
			}
			currentTerms = [...currentTerms, { ...createdTerm, children: createdTerm.children ?? [] }];
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

type TestScreen = Awaited<ReturnType<typeof render>>;

async function openPicker(screen: TestScreen, label: string) {
	const trigger = screen.getByRole("button", { name: `Choose ${label}` });
	await expect.element(trigger).toBeInTheDocument();
	await trigger.click();
	const input = screen.getByRole("searchbox", { name: `Search ${label}` });
	await expect.element(input).toHaveFocus();
	return input;
}

describe("TaxonomySidebar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockApiFetch();
	});

	it("shows flat terms in the shared searchable picker", async () => {
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});
		await openPicker(screen, "Tags");
		await expect.element(screen.getByRole("checkbox", { name: "Alpha" })).toBeInTheDocument();
		await expect.element(screen.getByRole("checkbox", { name: "Beta" })).toBeInTheDocument();
	});

	it("places the picker trigger beside the visible taxonomy label", async () => {
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});
		const label = screen.getByText("Tags", { exact: true });
		const trigger = screen.getByRole("button", { name: "Choose Tags" });

		await expect.element(label).toBeVisible();
		expect(label.element().closest("label")).toBeNull();
		await expect.element(trigger).toBeInTheDocument();
		expect(trigger.element().parentElement).toBe(label.element().parentElement);
	});

	it("hard-bounds large option lists while exact selected matches remain reachable", async () => {
		const terms = Array.from({ length: 250 }, (_, index) =>
			makeTerm(`term_${index + 1}`, `Term ${index + 1}`),
		);
		mockApiFetch({ terms, entryTerms: terms });
		const screen = await render(
			<TaxonomySidebar collection="products" entryId="entry_1" canManageTaxonomies />,
			{ wrapper: Wrapper },
		);
		const input = await openPicker(screen, "Tags");
		const options = screen.getByRole("group", { name: "Tags options" });

		await expect.element(screen.getByLabelText("Remove Term 250")).toBeInTheDocument();
		await expect.element(options).toBeInTheDocument();
		expect(options.element().querySelectorAll('[role="checkbox"]')).toHaveLength(100);
		expect(screen.getByRole("checkbox", { name: "Term 250" }).query()).toBeNull();

		await input.fill("Term");
		await vi.waitFor(() => {
			expect(options.element().querySelectorAll('[role="checkbox"]')).toHaveLength(100);
		});

		await input.fill("Term 250");
		await expect.element(screen.getByRole("checkbox", { name: "Term 250" })).toBeChecked();
	});

	it("assigns an existing flat term by label", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies onChange={onChange} />,
			{ wrapper: Wrapper },
		);

		await (await openPicker(screen, "Tags")).fill("Alpha");
		await userEvent.keyboard("{Enter}");

		expect(onChange).toHaveBeenCalledWith("tags", ["term_alpha"]);
		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
	});

	it("explains when saved term changes affect published content", async () => {
		const screen = await render(
			<TaxonomySidebar collection="products" entryId="entry_1" canManageTaxonomies />,
			{ wrapper: Wrapper },
		);
		await (await openPicker(screen, "Tags")).fill("Alpha");
		await userEvent.keyboard("{Enter}");
		await expect
			.element(screen.getByText("Saved immediately; term changes do not wait for Publish changes."))
			.toBeInTheDocument();
	});

	it("assigns comma-separated existing terms together", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies onChange={onChange} />,
			{ wrapper: Wrapper },
		);

		await (await openPicker(screen, "Tags")).fill("Alpha, Beta");
		await userEvent.keyboard("{Enter}");

		expect(onChange).toHaveBeenCalledWith("tags", ["term_alpha", "term_beta"]);
		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Remove Beta")).toBeInTheDocument();
	});

	it("preserves pasted line breaks and creates separate tags", async () => {
		mockApiFetch({ terms: [] });
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});
		const input = await openPicker(screen, "Tags");
		const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", {
			value: { getData: () => "First line\rSecond line\nThird line" },
		});

		input.element().dispatchEvent(paste);
		await expect.element(input).toHaveValue("First line, Second line, Third line");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => {
			const bodies = vi
				.mocked(apiFetch)
				.mock.calls.filter(
					([url, init]) =>
						requestUrl(url).endsWith("/taxonomies/tags/terms") && init?.method === "POST",
				)
				.map(([, init]) => (typeof init?.body === "string" ? JSON.parse(init.body) : null));
			expect(bodies).toEqual([
				{ label: "First line" },
				{ label: "Second line" },
				{ label: "Third line" },
			]);
		});
	});

	it("creates pasted tags sequentially", async () => {
		const releases: Array<() => void> = [];
		let activeRequests = 0;
		let maxActiveRequests = 0;
		const createTermRequest = vi.fn(async (label: string) => {
			activeRequests += 1;
			maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
			await new Promise<void>((resolve) => releases.push(resolve));
			activeRequests -= 1;
			return dataResponse({ term: makeTerm(`term_${label.toLowerCase()}`, label) });
		});
		mockApiFetch({ terms: [], createTermRequest });
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});

		await (await openPicker(screen, "Tags")).fill("First, Second, Third");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => expect(createTermRequest).toHaveBeenCalledTimes(1));
		releases.shift()?.();
		await vi.waitFor(() => expect(createTermRequest).toHaveBeenCalledTimes(2));
		releases.shift()?.();
		await vi.waitFor(() => expect(createTermRequest).toHaveBeenCalledTimes(3));
		releases.shift()?.();
		await vi.waitFor(() => expect(activeRequests).toBe(0));
		expect(maxActiveRequests).toBe(1);
	});

	it("preserves configured taxonomy label casing in picker copy", async () => {
		mockApiFetch({
			taxonomies: [{ ...tagsTaxonomy, label: "SEO Tags", labelSingular: "SEO Tag" }],
			terms: [],
		});
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});

		const input = await openPicker(screen, "SEO Tags");
		await expect.element(input).toHaveAttribute("placeholder", "Search SEO Tags…");
		await expect.element(screen.getByText("No SEO Tags found.")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Create a new SEO Tag" }))
			.toBeInTheDocument();
	});

	it("creates new terms and assigns exact matches in one update", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies onChange={onChange} />,
			{ wrapper: Wrapper },
		);

		await (await openPicker(screen, "Tags")).fill("Alpha, Gamma");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => {
			expect(onChange).toHaveBeenCalledWith("tags", ["term_alpha", "term_created"]);
		});
		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
	});

	it("maps a folded exact label to the existing term instead of creating a duplicate", async () => {
		const onChange = vi.fn();
		mockApiFetch({ terms: [makeTerm("term_mexico", "México")] });
		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies onChange={onChange} />,
			{ wrapper: Wrapper },
		);

		await (await openPicker(screen, "Tags")).fill("Mexico");
		await userEvent.keyboard("{Enter}");

		expect(onChange).toHaveBeenCalledWith("tags", ["term_mexico"]);
		expect(
			vi
				.mocked(apiFetch)
				.mock.calls.some(
					([url, init]) =>
						requestUrl(url).endsWith("/taxonomies/tags/terms") && init?.method === "POST",
				),
		).toBe(false);
	});

	it("deduplicates folded labels within one tag batch", async () => {
		mockApiFetch({ terms: [] });
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});

		await (await openPicker(screen, "Tags")).fill("México, Mexico");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => {
			const createCalls = vi
				.mocked(apiFetch)
				.mock.calls.filter(
					([url, init]) =>
						requestUrl(url).endsWith("/taxonomies/tags/terms") && init?.method === "POST",
				);
			expect(createCalls).toHaveLength(1);
			const body = createCalls[0]?.[1]?.body;
			expect(typeof body === "string" ? JSON.parse(body) : null).toEqual({ label: "México" });
		});
	});

	it("marks assigned flat terms as selected in the shared picker", async () => {
		mockApiFetch({ entryTerms: [alphaTerm] });
		const screen = await render(
			<TaxonomySidebar collection="products" entryId="entry_1" canManageTaxonomies />,
			{ wrapper: Wrapper },
		);
		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
		await openPicker(screen, "Tags");
		await expect.element(screen.getByRole("checkbox", { name: "Alpha" })).toBeChecked();
		await expect.element(screen.getByRole("checkbox", { name: "Beta" })).not.toBeChecked();
	});

	it("removes the last selected flat term with Backspace", async () => {
		const onChange = vi.fn();
		mockApiFetch({ entryTerms: [alphaTerm] });

		const screen = await render(
			<TaxonomySidebar
				collection="products"
				entryId="entry_1"
				canManageTaxonomies
				onChange={onChange}
			/>,
			{ wrapper: Wrapper },
		);

		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
		await openPicker(screen, "Tags");
		await userEvent.keyboard("{Backspace}");

		expect(onChange).toHaveBeenCalledWith("tags", []);
	});

	it("serializes rapid flat-term saves", async () => {
		let resolveFirstSave: (response: Response) => void = () => undefined;
		const firstSave = new Promise<Response>((resolve) => {
			resolveFirstSave = resolve;
		});
		const saveEntryTerms = vi.fn((init?: RequestInit) => dataResponse({ init }));
		saveEntryTerms.mockImplementationOnce(() => firstSave);
		mockApiFetch({ entryTerms: [alphaTerm], saveEntryTerms });

		const screen = await render(
			<TaxonomySidebar collection="products" entryId="entry_1" canManageTaxonomies />,
			{ wrapper: Wrapper },
		);

		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
		const input = await openPicker(screen, "Tags");
		await userEvent.keyboard("{Backspace}");
		await input.fill("Beta");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => expect(saveEntryTerms).toHaveBeenCalledTimes(1));
		resolveFirstSave(new Response(null, { status: 200 }));
		await vi.waitFor(() => expect(saveEntryTerms).toHaveBeenCalledTimes(2));

		const requestBodies = saveEntryTerms.mock.calls.map(([init]) =>
			typeof init?.body === "string" ? JSON.parse(init.body) : null,
		);
		expect(requestBodies).toEqual([{ termIds: [] }, { termIds: ["term_beta"] }]);
	});

	it("creates a flat term from the tag input", async () => {
		const onChange = vi.fn();
		mockApiFetch({ terms: [] });

		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies onChange={onChange} />,
			{
				wrapper: Wrapper,
			},
		);

		const input = await openPicker(screen, "Tags");
		await input.fill("Gamma");
		await userEvent.keyboard("{Enter}");

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

		await (await openPicker(screen, "Tags")).fill("音楽");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => {
			const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "POST");
			expect(call).toBeDefined();
			const body = typeof call?.[1]?.body === "string" ? JSON.parse(call[1].body) : undefined;
			expect(body).toEqual({ label: "音楽" });
		});
	});

	it("shows flat-term creation errors below the tag input", async () => {
		mockApiFetch({ terms: [], createError: "Term could not be created" });
		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});

		await (await openPicker(screen, "Tags")).fill("Gamma");
		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByText("Term could not be created")).toBeInTheDocument();
	});

	it("selects successful terms and reports failed labels from a partial batch", async () => {
		const onChange = vi.fn();
		mockApiFetch({ terms: [], createErrorFor: "Second" });
		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies onChange={onChange} />,
			{ wrapper: Wrapper },
		);

		await (await openPicker(screen, "Tags")).fill("First, Second");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => {
			expect(onChange).toHaveBeenCalledWith("tags", ["term_created"]);
		});
		await expect.element(screen.getByText("Failed to create Second")).toBeInTheDocument();
		expect(
			vi
				.mocked(apiFetch)
				.mock.calls.filter(
					([url, init]) =>
						requestUrl(url).endsWith("/taxonomies/tags/terms") && init?.method === "POST",
				),
		).toHaveLength(2);
	});

	it("keeps an existing match when the new label in its batch fails", async () => {
		const onChange = vi.fn();
		mockApiFetch({ terms: [alphaTerm], createErrorFor: "Second" });
		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies onChange={onChange} />,
			{ wrapper: Wrapper },
		);

		await (await openPicker(screen, "Tags")).fill("Alpha, Second");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => {
			expect(onChange).toHaveBeenCalledWith("tags", ["term_alpha"]);
		});
		await expect.element(screen.getByText("Failed to create Second")).toBeInTheDocument();
		expect(
			vi
				.mocked(apiFetch)
				.mock.calls.filter(
					([url, init]) =>
						requestUrl(url).endsWith("/taxonomies/tags/terms") && init?.method === "POST",
				),
		).toHaveLength(1);
	});

	it("renders hierarchical taxonomies as a searchable category picker", async () => {
		mockApiFetch({ taxonomies: [categoriesTaxonomy], terms: [alphaTerm] });

		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});
		expect(screen.getByRole("searchbox", { name: "Search Categories" }).query()).toBeNull();
		expect(screen.getByRole("checkbox", { name: "Alpha" }).query()).toBeNull();

		await openPicker(screen, "Categories");
		await expect.element(screen.getByRole("checkbox", { name: "Alpha" })).toBeInTheDocument();
	});

	it("moves focus to the announced checkbox with arrow navigation", async () => {
		const onChange = vi.fn();
		mockApiFetch({ taxonomies: [categoriesTaxonomy], terms: [alphaTerm, betaTerm] });
		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies onChange={onChange} />,
			{ wrapper: Wrapper },
		);
		await openPicker(screen, "Categories");
		const alpha = screen.getByRole("checkbox", { name: "Alpha" });

		await userEvent.keyboard("{ArrowDown}");
		await expect.element(alpha).toHaveFocus();
		await userEvent.keyboard("{Enter}");

		expect(onChange).toHaveBeenCalledWith("categories", ["term_alpha"]);
	});

	it("finds and assigns nested categories with the keyboard", async () => {
		const onChange = vi.fn();
		const child = { ...makeTerm("term_child", "Child"), parentId: alphaTerm.id };
		mockApiFetch({
			taxonomies: [categoriesTaxonomy],
			terms: [{ ...alphaTerm, children: [child] }],
		});
		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies onChange={onChange} />,
			{ wrapper: Wrapper },
		);

		await (await openPicker(screen, "Categories")).fill("Child");
		await userEvent.keyboard("{Enter}");

		expect(onChange).toHaveBeenCalledWith("categories", ["term_child"]);
		await expect.element(screen.getByLabelText("Remove Child")).toBeInTheDocument();
	});

	it("removes a selected category from its chip", async () => {
		const onChange = vi.fn();
		mockApiFetch({
			taxonomies: [categoriesTaxonomy],
			terms: [alphaTerm],
			entryTerms: [alphaTerm],
		});
		const screen = await render(
			<TaxonomySidebar
				collection="products"
				entryId="entry_1"
				canManageTaxonomies
				onChange={onChange}
			/>,
			{ wrapper: Wrapper },
		);

		await screen.getByLabelText("Remove Alpha").click();

		expect(onChange).toHaveBeenCalledWith("categories", []);
		await expect
			.element(screen.getByRole("button", { name: "Choose Categories" }))
			.toBeInTheDocument();
	});

	it("opens the picker from the selected category field and supports keyboard selection", async () => {
		const onChange = vi.fn();
		mockApiFetch({
			taxonomies: [categoriesTaxonomy],
			terms: [alphaTerm, betaTerm],
			entryTerms: [alphaTerm],
		});
		const screen = await render(
			<TaxonomySidebar
				collection="products"
				entryId="entry_1"
				canManageTaxonomies
				onChange={onChange}
			/>,
			{ wrapper: Wrapper },
		);

		const fieldTrigger = screen.getByRole("button", { name: "Edit Categories" });
		await screen.getByText("Alpha", { exact: true }).click();
		const input = screen.getByRole("searchbox", { name: "Search Categories" });
		await expect.element(input).toHaveFocus();

		await input.fill("Beta");
		await userEvent.keyboard("{Enter}");

		expect(onChange).toHaveBeenCalledWith("categories", ["term_alpha", "term_beta"]);

		await userEvent.keyboard("{Escape}");
		await expect.element(fieldTrigger).toHaveFocus();
		expect(screen.getByRole("searchbox", { name: "Search Categories" }).query()).toBeNull();
	});

	it("keeps selected chips inside the control and scrolls after three rows", async () => {
		const selectedTerms = Array.from({ length: 8 }, (_, index) =>
			makeTerm(`term_${index}`, `Long category ${index + 1}`),
		);
		mockApiFetch({
			taxonomies: [categoriesTaxonomy],
			terms: selectedTerms,
			entryTerms: selectedTerms,
		});
		const screen = await render(
			<div style={{ width: "320px" }}>
				<TaxonomySidebar collection="products" entryId="entry_1" canManageTaxonomies />
			</div>,
			{ wrapper: Wrapper },
		);

		const selectedList = screen.getByRole("list", { name: "Selected Categories" });
		await expect.element(selectedList).toBeInTheDocument();
		const listElement = selectedList.element();
		const listRect = listElement.getBoundingClientRect();
		const chips = [...listElement.querySelectorAll<HTMLElement>('[role="listitem"]')];
		const firstChip = chips[0];
		if (!firstChip) {
			throw new Error("Expected visible selected-term chips");
		}
		const firstChipRect = firstChip.getBoundingClientRect();

		expect(listElement.clientHeight).toBeLessThanOrEqual(86);
		expect(listElement.scrollHeight).toBeGreaterThan(listElement.clientHeight);
		expect(firstChipRect.left).toBeGreaterThan(listRect.left);
		expect(firstChipRect.top).toBeGreaterThan(listRect.top);
		expect(listElement.scrollWidth).toBe(listElement.clientWidth);
	});

	it("closes the category picker with Escape and restores focus to its trigger", async () => {
		mockApiFetch({ taxonomies: [categoriesTaxonomy], terms: [alphaTerm] });

		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});
		const trigger = screen.getByRole("button", { name: "Choose Categories" });
		const input = await openPicker(screen, "Categories");

		await input.fill("Alpha");
		await expect.element(screen.getByRole("checkbox", { name: "Alpha" })).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");

		expect(screen.getByRole("checkbox", { name: "Alpha" }).query()).toBeNull();
		await expect.element(trigger).toHaveFocus();
		expect(screen.getByRole("searchbox", { name: "Search Categories" }).query()).toBeNull();
	});

	it("keeps rendering after creating a hierarchical term", async () => {
		mockApiFetch({
			taxonomies: [categoriesTaxonomy],
			terms: [alphaTerm],
			createdTerm: {
				id: "term_created",
				name: "gamma",
				slug: "gamma",
				label: "Gamma",
				parentId: null,
				locale: "en",
				translationGroup: "term_created",
			},
		});

		const screen = await render(<TaxonomySidebar collection="products" canManageTaxonomies />, {
			wrapper: Wrapper,
		});

		await (await openPicker(screen, "Categories")).fill("Gamma");
		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByLabelText("Remove Gamma")).toBeInTheDocument();
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

		await expect.element(screen.getByText("Schlagwörter", { exact: true }).first()).toBeVisible();
		expect(screen.getByText("Tags").query()).toBeNull();
		expect(screen.getByText("Étiquettes").query()).toBeNull();
		await openPicker(screen, "Schlagwörter");
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
			await (await openPicker(screen, "Tags")).fill("أمن المعلومات");
			await userEvent.keyboard("{Enter}");

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

	it("labels fallback terms in the shared picker", async () => {
		const screen = await render(
			<TaxonomySidebar
				collection="products"
				entryId="entry_1"
				entryLocale="fr"
				canManageTaxonomies
			/>,
			{ wrapper: Wrapper },
		);

		await openPicker(screen, "Tags");
		await expect
			.element(screen.getByRole("checkbox", { name: /Alpha.*EN fallback/ }))
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

		await (await openPicker(screen, "Tags")).fill("Beta");
		await userEvent.keyboard("{Enter}");

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
		await expect.element(screen.getByRole("button", { name: "Choose Tags" })).toBeInTheDocument();

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
		await (await openPicker(screen, "Tags")).fill("Gamma");
		await expect.element(screen.getByText("No tags found.")).toBeInTheDocument();
		await userEvent.keyboard("{Enter}");
		expect(
			vi
				.mocked(apiFetch)
				.mock.calls.some(
					([url, init]) =>
						requestUrl(url).endsWith("/taxonomies/tags/terms") && init?.method === "POST",
				),
		).toBe(false);
	});

	it("hides hierarchical term creation without taxonomy management permission", async () => {
		mockApiFetch({ taxonomies: [categoriesTaxonomy], terms: [alphaTerm] });
		const screen = await render(
			<TaxonomySidebar collection="products" canManageTaxonomies={false} />,
			{ wrapper: Wrapper },
		);

		await (await openPicker(screen, "Categories")).fill("Gamma");
		await expect.element(screen.getByText("No categories found.")).toBeInTheDocument();
		await userEvent.keyboard("{Enter}");
		expect(
			vi
				.mocked(apiFetch)
				.mock.calls.some(
					([url, init]) =>
						requestUrl(url).endsWith("/taxonomies/categories/terms") && init?.method === "POST",
				),
		).toBe(false);
	});
});
