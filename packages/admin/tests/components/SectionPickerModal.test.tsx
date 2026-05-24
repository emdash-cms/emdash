import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Section, SectionCategory, SectionsResult } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

const mockFetchSections = vi.fn<() => Promise<SectionsResult>>();
const mockFetchSectionCategories = vi.fn<() => Promise<SectionCategory[]>>();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchSections: (...args: unknown[]) => mockFetchSections(...(args as [])),
		fetchSectionCategories: (...args: unknown[]) => mockFetchSectionCategories(...(args as [])),
	};
});

// Import after mocks
const { SectionPickerModal } = await import("../../src/components/SectionPickerModal");

function makeSection(overrides: Partial<Section> = {}): Section {
	return {
		id: "sec_01",
		slug: "hero",
		title: "Hero Section",
		description: "Main hero",
		keywords: [],
		content: [],
		source: "theme",
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-02T00:00:00Z",
		...overrides,
	};
}

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("SectionPickerModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchSections.mockResolvedValue({
			items: [
				makeSection({
					id: "sec_01",
					slug: "hero",
					title: "Hero Section",
					description: "Main hero",
					source: "theme",
				}),
				makeSection({
					id: "sec_02",
					slug: "cta",
					title: "Call to Action",
					description: "CTA block",
					source: "user",
				}),
			],
		});
		mockFetchSectionCategories.mockResolvedValue([
			{ id: "cat_1", slug: "layout", label: "Layout", sortOrder: 0 },
			{ id: "cat_2", slug: "marketing", label: "Marketing", sortOrder: 1 },
		]);
	});

	it("shows sections when open", async () => {
		const screen = await render(
			<Wrapper>
				<SectionPickerModal open={true} onOpenChange={vi.fn()} onSelect={vi.fn()} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Hero Section")).toBeInTheDocument();
		await expect.element(screen.getByText("Call to Action")).toBeInTheDocument();
	});

	it("clicking a section calls onSelect and closes modal", async () => {
		const onSelect = vi.fn();
		const onOpenChange = vi.fn();
		const screen = await render(
			<Wrapper>
				<SectionPickerModal open={true} onOpenChange={onOpenChange} onSelect={onSelect} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Hero Section")).toBeInTheDocument();
		// The Base UI dialog puts an inert overlay. Use direct DOM click to bypass it.
		const heroEl = screen.getByText("Hero Section").element();
		const button = heroEl.closest("button");
		button!.click();
		expect(onSelect).toHaveBeenCalledWith(
			expect.objectContaining({ slug: "hero", title: "Hero Section" }),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("search input filters results", async () => {
		const screen = await render(
			<Wrapper>
				<SectionPickerModal open={true} onOpenChange={vi.fn()} onSelect={vi.fn()} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Hero Section")).toBeInTheDocument();
		const searchInput = screen.getByPlaceholder("Search sections...");
		await searchInput.fill("cta");
		// Search is debounced — wait for the query to fire
		await vi.waitFor(() => {
			expect(mockFetchSections).toHaveBeenCalledWith(expect.objectContaining({ search: "cta" }));
		});
	});

	it("cancel button closes modal", async () => {
		const onOpenChange = vi.fn();
		const screen = await render(
			<Wrapper>
				<SectionPickerModal open={true} onOpenChange={onOpenChange} onSelect={vi.fn()} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Insert Section")).toBeInTheDocument();
		// Direct DOM click to bypass the inert overlay
		const cancelEl = screen.getByText("Cancel").element();
		cancelEl.click();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("queries do not fire when closed", async () => {
		await render(
			<Wrapper>
				<SectionPickerModal open={false} onOpenChange={vi.fn()} onSelect={vi.fn()} />
			</Wrapper>,
		);
		// Wait a tick to let any queries that might fire settle
		await new Promise((r) => setTimeout(r, 50));
		expect(mockFetchSections).not.toHaveBeenCalled();
		expect(mockFetchSectionCategories).not.toHaveBeenCalled();
	});

	it("state resets when modal reopens", async () => {
		const onOpenChange = vi.fn();
		const screen = await render(
			<Wrapper>
				<SectionPickerModal open={true} onOpenChange={onOpenChange} onSelect={vi.fn()} />
			</Wrapper>,
		);
		// Type something in search
		const searchInput = screen.getByPlaceholder("Search sections...");
		await searchInput.fill("test");
		// Close and reopen
		await screen.rerender(
			<Wrapper>
				<SectionPickerModal open={false} onOpenChange={onOpenChange} onSelect={vi.fn()} />
			</Wrapper>,
		);
		await screen.rerender(
			<Wrapper>
				<SectionPickerModal open={true} onOpenChange={onOpenChange} onSelect={vi.fn()} />
			</Wrapper>,
		);
		// Search should be reset — the input should have an empty value
		await vi.waitFor(() => {
			const input = document.querySelector(
				'input[placeholder="Search sections..."]',
			) as HTMLInputElement | null;
			expect(input?.value ?? "").toBe("");
		});
	});

	it("shows empty state messaging when no sections match", async () => {
		mockFetchSections.mockResolvedValue({ items: [] });
		const screen = await render(
			<Wrapper>
				<SectionPickerModal open={true} onOpenChange={vi.fn()} onSelect={vi.fn()} />
			</Wrapper>,
		);
		await expect.element(screen.getByText("No sections available")).toBeInTheDocument();
	});

	it("shows filtered empty state when search has no results", async () => {
		mockFetchSections.mockResolvedValue({ items: [] });
		const screen = await render(
			<Wrapper>
				<SectionPickerModal open={true} onOpenChange={vi.fn()} onSelect={vi.fn()} />
			</Wrapper>,
		);
		const searchInput = screen.getByPlaceholder("Search sections...");
		await searchInput.fill("nonexistent");
		await expect.element(screen.getByText("No sections found")).toBeInTheDocument();
	});
});
