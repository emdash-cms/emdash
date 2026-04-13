import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Section, SectionsResult } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// Mock router
vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
		useNavigate: () => vi.fn(),
	};
});

const mockFetchSections = vi.fn<() => Promise<SectionsResult>>();
const mockCreateSection = vi.fn();
const mockDeleteSection = vi.fn();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchSections: (...args: unknown[]) => mockFetchSections(...(args as [])),
		createSection: (...args: unknown[]) => mockCreateSection(...(args as [])),
		deleteSection: (...args: unknown[]) => mockDeleteSection(...(args as [])),
	};
});

// Import after mocks
const { Sections } = await import("../../src/components/Sections");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DELETE_SECTION_MSG_REGEX = /This will permanently delete/;

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
	return (
		<QueryClientProvider client={qc}>
			<Toasty>{children}</Toasty>
		</QueryClientProvider>
	);
}

describe("Sections", () => {
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
		mockCreateSection.mockResolvedValue(makeSection({ slug: "new-section" }));
		mockDeleteSection.mockResolvedValue(undefined);
	});

	it("displays sections with titles and descriptions", async () => {
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Hero Section")).toBeInTheDocument();
		await expect.element(screen.getByText("Call to Action")).toBeInTheDocument();
		await expect.element(screen.getByText("Main hero")).toBeInTheDocument();
		await expect.element(screen.getByText("CTA block")).toBeInTheDocument();
	});

	it("create button opens dialog with title/slug form", async () => {
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await screen.getByText("New Section").click();
		await expect.element(screen.getByText("Create Section")).toBeInTheDocument();
		// Check form fields exist — InputArea uses label prop but may not be associated via aria
		await expect.element(screen.getByLabelText("Title")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Slug")).toBeInTheDocument();
	});

	it("auto-generates slug from title in create dialog", async () => {
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await screen.getByText("New Section").click();
		const titleInput = screen.getByLabelText("Title");
		await titleInput.fill("My Great Section");
		// Slug should be auto-generated
		await expect.element(screen.getByLabelText("Slug")).toHaveValue("my-great-section");
	});

	it("search input filters sections", async () => {
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		const searchInput = screen.getByPlaceholder("Search sections...");
		await searchInput.fill("hero");
		// fetchSections will be called again with search param
		expect(mockFetchSections).toHaveBeenCalledWith(expect.objectContaining({ search: "hero" }));
	});

	it("delete button opens confirmation dialog", async () => {
		mockFetchSections.mockResolvedValue({
			items: [
				makeSection({
					id: "sec_02",
					slug: "cta",
					title: "Call to Action",
					description: "CTA block",
					source: "user",
				}),
			],
		});
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Call to Action")).toBeInTheDocument();
		// Click delete on the user section
		const deleteButton = screen.getByTitle("Delete");
		await deleteButton.click();
		await expect.element(screen.getByText("Delete Section?")).toBeInTheDocument();
		await expect.element(screen.getByText(DELETE_SECTION_MSG_REGEX)).toBeInTheDocument();
	});

	it("theme sections have disabled delete button", async () => {
		mockFetchSections.mockResolvedValue({
			items: [
				makeSection({
					id: "sec_01",
					slug: "hero",
					title: "Hero Section",
					source: "theme",
				}),
			],
		});
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Hero Section")).toBeInTheDocument();
		const deleteButton = screen.getByTitle("Cannot delete theme sections");
		await expect.element(deleteButton).toBeDisabled();
	});

	it("each section has an edit button", async () => {
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Hero Section")).toBeInTheDocument();
		const editButtons = screen.getByText("Edit").all();
		expect(editButtons.length).toBe(2);
	});
});
