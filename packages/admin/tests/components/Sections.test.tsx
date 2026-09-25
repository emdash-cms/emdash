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

	it("announces loading sections once", async () => {
		mockFetchSections.mockImplementation(() => new Promise(() => {}));
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading sections...");
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

	it("does not present stored text as a visual preview", async () => {
		mockFetchSections.mockResolvedValue({
			items: [
				makeSection({
					title: "Newsletter Signup",
					description: "A newsletter call to action",
					content: [
						{
							_type: "block",
							style: "h3",
							children: [{ _type: "span", text: "Stay in the loop" }],
						},
						{ _type: "block", children: [{ _type: "span", text: "Newsletter body copy" }] },
					],
				}),
				makeSection({
					id: "sec_02",
					slug: "about-author",
					title: "About the Author",
					description: "A short author bio",
					content: [{ _type: "block", children: [{ _type: "span", text: "Author body copy" }] }],
				}),
			],
		});
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Newsletter Signup")).toBeInTheDocument();
		await expect.element(screen.getByText("About the Author")).toBeInTheDocument();
		await expect.element(screen.getByText("A newsletter call to action")).toBeInTheDocument();
		await expect.element(screen.getByText("A short author bio")).toBeInTheDocument();
		await expect.element(screen.getByText("Stay in the loop")).not.toBeInTheDocument();
		await expect.element(screen.getByText("Author body copy")).not.toBeInTheDocument();
	});

	it("keeps the image preview when one is available", async () => {
		mockFetchSections.mockResolvedValue({
			items: [
				makeSection({
					previewUrl: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
					content: [
						{ _type: "block", children: [{ _type: "span", text: "Image replaces this text" }] },
					],
				}),
			],
		});
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await expect
			.element(screen.getByRole("img", { name: "Preview of Hero Section" }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Image replaces this text")).not.toBeInTheDocument();
	});

	it("create button opens dialog with title/slug form", async () => {
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await screen.getByText("New section").click();
		await expect
			.element(screen.getByRole("heading", { name: "Create section" }))
			.toBeInTheDocument();
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
		await screen.getByText("New section").click();
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

	it("offers a retry when sections fail to load", async () => {
		mockFetchSections.mockRejectedValueOnce(new Error("Offline"));
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Sections could not be loaded.")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Retry" }).click();
		await expect.element(screen.getByText("Hero Section")).toBeInTheDocument();
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
		await screen.getByRole("button", { name: "More actions for Call to Action" }).click();
		await screen.getByRole("menuitem", { name: "Delete Call to Action" }).click();
		await expect.element(screen.getByText("Delete Section?")).toBeInTheDocument();
		await expect.element(screen.getByText(DELETE_SECTION_MSG_REGEX)).toBeInTheDocument();
	});

	it("explains why theme sections cannot be deleted", async () => {
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
		await screen.getByRole("button", { name: "More actions for Hero Section" }).click();
		await expect
			.element(screen.getByRole("menuitem", { name: "Cannot delete theme sections" }))
			.toHaveAttribute("aria-disabled", "true");
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
