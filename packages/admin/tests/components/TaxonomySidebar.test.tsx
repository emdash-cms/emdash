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
const securityTerms = [
	makeTerm("term_application_security", "Application Security"),
	makeTerm("term_cloud_security", "Cloud Security"),
	makeTerm("term_data_security", "Data Security"),
	makeTerm("term_email_security", "Email Security"),
	makeTerm("term_network_security", "Network Security"),
	makeTerm("term_security", "Security"),
	makeTerm("term_web_security", "Web Security"),
];
const overflowingSecurityTerms = [
	...securityTerms,
	makeTerm("term_api_security", "API Security"),
	makeTerm("term_browser_security", "Browser Security"),
	makeTerm("term_dns_security", "DNS Security"),
	makeTerm("term_origin_security", "Origin Security"),
	makeTerm("term_zero_trust_security", "Zero Trust Security"),
];

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

function parseJsonBody<T>(init?: RequestInit): T {
	if (typeof init?.body !== "string") throw new TypeError("Expected a JSON request body");
	return JSON.parse(init.body) as T;
}

function mockApiFetch({
	taxonomies = [tagsTaxonomy],
	terms = [alphaTerm, betaTerm],
	entryTerms = [],
	deferSaves = false,
	deferTermRefetch = false,
	deferCreate = false,
	createError,
}: {
	taxonomies?: TestTaxonomy[];
	terms?: TestTerm[];
	entryTerms?: TestTerm[];
	deferSaves?: boolean;
	deferTermRefetch?: boolean;
	deferCreate?: boolean;
	createError?: string;
} = {}) {
	const currentTerms = [...terms];
	let currentEntryTerms = [...entryTerms];
	const saveRequests: string[][] = [];
	const pendingSaveResponses: Array<() => void> = [];
	const pendingTermRefetches: Array<() => void> = [];
	const pendingCreateResponses: Array<() => void> = [];
	let entryTermFetches = 0;
	let termFetches = 0;
	let createRequests = 0;

	vi.mocked(apiFetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
		const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		const path = new URL(urlString, "http://localhost").pathname;
		const method = init?.method ?? "GET";

		if (method === "GET" && path === "/_emdash/api/taxonomies") {
			return dataResponse({ taxonomies });
		}

		if (method === "GET" && path === "/_emdash/api/taxonomies/tags/terms") {
			termFetches += 1;
			if (deferTermRefetch && termFetches > 1) {
				return new Promise<Response>((resolve) => {
					pendingTermRefetches.push(() => void dataResponse({ terms: currentTerms }).then(resolve));
				});
			}
			return dataResponse({ terms: currentTerms });
		}

		if (method === "GET" && path === "/_emdash/api/taxonomies/categories/terms") {
			return dataResponse({ terms });
		}

		if (method === "GET" && path === "/_emdash/api/content/products/entry_1/terms/tags") {
			entryTermFetches += 1;
			return dataResponse({ terms: currentEntryTerms });
		}

		if (method === "POST" && path === "/_emdash/api/taxonomies/tags/terms") {
			createRequests += 1;
			if (createError) {
				return Promise.resolve(
					new Response(
						JSON.stringify({ error: { code: "TERM_CREATE_ERROR", message: createError } }),
						{
							status: 409,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			const body = parseJsonBody<{ label: string; slug: string }>(init);
			const respond = () => {
				const term = makeTerm(`term_${body.slug}`, body.label);
				currentTerms.push(term);
				return dataResponse({ term });
			};
			if (!deferCreate) return respond();
			return new Promise<Response>((resolve) => {
				pendingCreateResponses.push(() => void respond().then(resolve));
			});
		}

		if (method === "POST" && path === "/_emdash/api/content/products/entry_1/terms/tags") {
			const body = parseJsonBody<{ termIds: string[] }>(init);
			saveRequests.push(body.termIds);
			const respond = () => {
				currentEntryTerms = currentTerms.filter((term) => body.termIds.includes(term.id));
				return dataResponse({});
			};
			if (!deferSaves) return respond();
			return new Promise<Response>((resolve) => {
				pendingSaveResponses.push(() => void respond().then(resolve));
			});
		}

		return dataResponse({});
	});

	return {
		saveRequests,
		releaseNextSave: () => pendingSaveResponses.shift()?.(),
		releaseTermRefetch: () => pendingTermRefetches.shift()?.(),
		releaseCreate: () => pendingCreateResponses.shift()?.(),
		get entryTermFetches() {
			return entryTermFetches;
		},
		get termFetches() {
			return termFetches;
		},
		get createRequests() {
			return createRequests;
		},
	};
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

		const input = screen.getByRole("combobox", { name: "Tags" });
		await expect.element(input).toBeInTheDocument();
		expect(screen.getByRole("option", { name: /^Alpha$/ }).query()).toBeNull();

		await input.click();

		await expect.element(screen.getByRole("option", { name: /^Alpha$/ })).toBeInTheDocument();
		await expect.element(screen.getByRole("option", { name: /^Beta$/ })).toBeInTheDocument();
	});

	it("filters flat taxonomy terms while preserving the create option for new input", async () => {
		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });

		const input = screen.getByRole("combobox", { name: "Tags" });
		await input.fill("Alp");

		await expect.element(screen.getByRole("option", { name: /^Alpha$/ })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: /^Beta$/ }).query()).toBeNull();
		await expect.element(screen.getByText('Create "Alp"')).toBeInTheDocument();
	});

	it("makes every matching term reachable and selects the exact match with Enter", async () => {
		mockApiFetch({ terms: securityTerms });

		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });
		const input = screen.getByRole("combobox", { name: "Tags" });

		await input.fill("security");

		for (const term of securityTerms) {
			await expect.element(screen.getByText(term.label, { exact: true })).toBeInTheDocument();
		}
		expect(screen.getByText('Create "security"').query()).toBeNull();

		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByLabelText("Remove Security")).toBeInTheDocument();
	});

	it("caps long match lists and makes the remaining options scrollable", async () => {
		mockApiFetch({ terms: overflowingSecurityTerms });
		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });

		await screen.getByRole("combobox", { name: "Tags" }).fill("security");

		const listbox = screen.getByRole("listbox").element();
		expect(listbox.scrollHeight).toBeGreaterThan(listbox.clientHeight);
	});

	it("selects a later matching term with the pointer", async () => {
		mockApiFetch({ terms: securityTerms });

		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });
		await screen.getByRole("combobox", { name: "Tags" }).fill("security");

		await screen.getByRole("option", { name: "Web Security" }).click();

		await expect.element(screen.getByLabelText("Remove Web Security")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("option", { name: "Application Security" }))
			.toBeInTheDocument();
	});

	it("shows assigned terms as removable selected options", async () => {
		mockApiFetch({ entryTerms: [alphaTerm] });

		const screen = await render(<TaxonomySidebar collection="products" entryId="entry_1" />, {
			wrapper: Wrapper,
		});

		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
		await screen.getByRole("combobox", { name: "Tags" }).click();

		await expect
			.element(screen.getByRole("option", { name: /^Alpha$/ }))
			.toHaveAttribute("aria-selected", "true");
		await expect.element(screen.getByRole("option", { name: /^Beta$/ })).toBeInTheDocument();

		await screen.getByLabelText("Remove Alpha").click();

		expect(screen.getByLabelText("Remove Alpha").query()).toBeNull();
	});

	it("serializes rapid assignment saves and refetches after the final write", async () => {
		const saves = mockApiFetch({ deferSaves: true });
		const screen = await render(<TaxonomySidebar collection="products" entryId="entry_1" />, {
			wrapper: Wrapper,
		});
		const input = screen.getByRole("combobox", { name: "Tags" });

		await input.click();
		await screen.getByRole("option", { name: "Alpha" }).click();
		await screen.getByRole("option", { name: "Beta" }).click();

		expect(saves.saveRequests).toEqual([[alphaTerm.id]]);
		saves.releaseNextSave();
		await vi.waitFor(() => expect(saves.saveRequests).toHaveLength(2));
		expect(saves.saveRequests[1]).toEqual([alphaTerm.id, betaTerm.id]);

		saves.releaseNextSave();
		await vi.waitFor(() => expect(saves.entryTermFetches).toBe(2));
		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Remove Beta")).toBeInTheDocument();
	});

	it("keeps the create prompt available when no flat taxonomy terms exist", async () => {
		mockApiFetch({ terms: [] });

		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });

		const input = screen.getByRole("combobox", { name: "Tags" });
		await input.click();

		expect(screen.getByText('Create "Gamma"').query()).toBeNull();

		await input.fill("Gamma");

		await expect.element(screen.getByText('Create "Gamma"')).toBeInTheDocument();

		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByLabelText("Remove Gamma")).toBeInTheDocument();
	});

	it("keeps failed creation input and exposes the retryable API error", async () => {
		mockApiFetch({ terms: [], createError: "Term already exists" });
		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });
		const input = screen.getByRole("combobox", { name: "Tags" });

		await input.fill("Gamma");
		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByText("Term already exists")).toBeInTheDocument();
		await expect.element(input).toHaveValue("Gamma");
		await expect.element(screen.getByText('Create "Gamma"')).toBeInTheDocument();

		await input.fill("Delta");

		expect(screen.getByText("Term already exists").query()).toBeNull();
		await expect.element(screen.getByText('Create "Delta"')).toBeInTheDocument();
	});

	it("shows a created tag before the authoritative term refetch finishes", async () => {
		const terms = mockApiFetch({ terms: [], deferTermRefetch: true });
		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });
		const input = screen.getByRole("combobox", { name: "Tags" });

		await input.fill("Gamma");
		await userEvent.keyboard("{Enter}");
		await vi.waitFor(() => expect(terms.termFetches).toBe(2));

		await expect.element(screen.getByLabelText("Remove Gamma")).toBeInTheDocument();
		terms.releaseTermRefetch();
	});

	it("keeps selections made while term creation is pending", async () => {
		const creation = mockApiFetch({ terms: [alphaTerm], deferCreate: true });
		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });
		const input = screen.getByRole("combobox", { name: "Tags" });

		await input.fill("Gamma");
		await userEvent.keyboard("{Enter}");
		await vi.waitFor(() => expect(creation.createRequests).toBe(1));
		await screen.getByRole("option", { name: "Alpha" }).click();

		creation.releaseCreate();
		await expect.element(screen.getByLabelText("Remove Gamma")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Remove Alpha")).toBeInTheDocument();
	});

	it("continues to render hierarchical taxonomies as a checkbox tree", async () => {
		mockApiFetch({ taxonomies: [categoriesTaxonomy], terms: [alphaTerm] });

		const screen = await render(<TaxonomySidebar collection="products" />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Categories")).toBeInTheDocument();
		await expect.element(screen.getByText("Alpha")).toBeInTheDocument();
		expect(screen.getByLabelText("Add Categories").query()).toBeNull();
	});
});
