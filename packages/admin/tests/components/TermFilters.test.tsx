import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TermFilters, type TermFilterState } from "../../src/components/TermFilters";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api/client.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/client.js");
	return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "../../src/lib/api/client.js";

const topics = {
	id: "tax_topics",
	name: "topics",
	label: "Topics",
	labelSingular: "Topic",
	hierarchical: true,
	collections: ["posts"],
};

function term(id: string, label: string, children: ReturnType<typeof term>[] = []) {
	return {
		id,
		name: "topics",
		slug: label.toLowerCase(),
		label,
		parentId: null,
		children,
		locale: "en",
		translationGroup: id,
	};
}

const terms = [term("t_rodeo", "Rodeo", [term("t_bronc", "Bronc")]), term("t_polo", "Polo")];

function dataResponse(data: unknown) {
	return Promise.resolve(
		new Response(JSON.stringify({ data }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

const requested: string[] = [];

function mockApi(taxonomies = [topics]) {
	requested.length = 0;
	vi.mocked(apiFetch).mockImplementation((input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		requested.push(url);
		const path = new URL(url, "http://localhost").pathname;
		if (path === "/_emdash/api/taxonomies") return dataResponse({ taxonomies });
		if (path === "/_emdash/api/taxonomies/topics/terms") return dataResponse({ terms });
		return dataResponse({});
	});
}

function Harness({
	collection = "posts",
	initial = {},
	onChange,
}: {
	collection?: string;
	initial?: TermFilterState;
	onChange: (next: TermFilterState) => void;
}) {
	const [client] = React.useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	);
	const [value, setValue] = React.useState(initial);
	return (
		<QueryClientProvider client={client}>
			<TermFilters
				collection={collection}
				value={value}
				locale="de"
				defaultLocale="en"
				onChange={(next) => {
					setValue(next);
					onChange(next);
				}}
			/>
			<span>ready</span>
		</QueryClientProvider>
	);
}

describe("TermFilters", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockApi();
	});

	it("renders no control for a collection without taxonomies", async () => {
		const screen = await render(<Harness collection="pages" onChange={vi.fn()} />);

		await expect.element(screen.getByText("ready")).toBeInTheDocument();
		await vi.waitFor(() => expect(requested.some((url) => url.includes("/taxonomies"))).toBe(true));
		expect(screen.getByRole("button", { name: "Filter by Topics" }).elements()).toHaveLength(0);
	});

	it("sends several picked terms as slugs and removes the key when cleared", async () => {
		const onChange = vi.fn();
		const screen = await render(<Harness onChange={onChange} />);

		await screen.getByRole("button", { name: "Filter by Topics" }).click();
		await screen.getByRole("checkbox", { name: "Rodeo" }).click();
		await screen.getByRole("checkbox", { name: "Polo" }).click();

		expect(onChange).toHaveBeenLastCalledWith({ topics: ["rodeo", "polo"] });
		await expect
			.element(screen.getByRole("button", { name: "Filter by Topics" }))
			.toHaveTextContent("2 Topics");

		await screen.getByRole("checkbox", { name: "Rodeo" }).click();
		await screen.getByRole("checkbox", { name: "Polo" }).click();
		expect(onChange).toHaveBeenLastCalledWith({});
	});

	it("lists child terms and offers no way to create a term", async () => {
		const screen = await render(<Harness onChange={vi.fn()} />);

		await screen.getByRole("button", { name: "Filter by Topics" }).click();

		await expect.element(screen.getByRole("searchbox", { name: "Search Topics" })).toBeVisible();
		await expect.element(screen.getByRole("checkbox", { name: "Bronc" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /create/i }).elements()).toHaveLength(0);
	});

	it("loads terms for the list's locale with fallback and without counts", async () => {
		await render(<Harness onChange={vi.fn()} />);

		await vi.waitFor(() =>
			expect(requested.find((url) => url.includes("/taxonomies/topics/terms"))).toBeDefined(),
		);
		const url = new URL(
			requested.find((entry) => entry.includes("/taxonomies/topics/terms"))!,
			"http://localhost",
		);
		expect(url.searchParams.get("includeCounts")).toBe("false");
		expect(url.searchParams.get("resolveFallback")).toBe("true");
		expect(url.searchParams.get("locale")).toBe("de");
	});
});
