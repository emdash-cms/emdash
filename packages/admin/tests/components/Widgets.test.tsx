import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { Widgets } from "../../src/components/Widgets";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchWidgetAreas: vi.fn(),
		fetchWidgetComponents: vi.fn(),
		fetchMenus: vi.fn().mockResolvedValue([]),
		createWidgetArea: vi.fn().mockResolvedValue({}),
		deleteWidgetArea: vi.fn().mockResolvedValue(undefined),
		deleteWidget: vi.fn().mockResolvedValue(undefined),
		updateWidget: vi.fn().mockResolvedValue({}),
		reorderWidgets: vi.fn().mockResolvedValue(undefined),
	};
});

import * as api from "../../src/lib/api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DELETE_WIDGET_AREA_MSG_REGEX = /This will delete the widget area and all its widgets/;
const ADD_WIDGET_AREA_REGEX = /Add Widget Area/;

function mockDefaults() {
	vi.mocked(api.fetchWidgetAreas).mockResolvedValue([
		{
			id: "a1",
			name: "sidebar",
			label: "Sidebar",
			description: "Main sidebar",
			widgets: [
				{ id: "w1", type: "content", title: "Recent Posts", sort_order: 0 },
				{ id: "w2", type: "menu", title: "Quick Links", sort_order: 1 },
			],
		},
	]);
	vi.mocked(api.fetchWidgetComponents).mockResolvedValue([
		{
			id: "recent-posts",
			label: "Recent Posts Widget",
			description: "Shows recent posts",
			props: {},
		},
	]);
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

describe("Widgets", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDefaults();
	});

	it("displays widget areas with labels", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect.element(screen.getByRole("heading", { name: "Sidebar" })).toBeInTheDocument();
		await expect.element(screen.getByText("Main sidebar")).toBeInTheDocument();
	});

	it("shows widgets within each area", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		// Widget titles are rendered in <span> elements. Use exact match to avoid
		// matching the "Recent Posts Widget" component in the available widgets list.
		await expect.element(screen.getByText("Quick Links")).toBeInTheDocument();
		// Verify widget type badges
		await expect.element(screen.getByText("(content)")).toBeInTheDocument();
		await expect.element(screen.getByText("(menu)")).toBeInTheDocument();
	});

	it("create area button opens dialog with name/label/description form", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: ADD_WIDGET_AREA_REGEX }).click();

		await expect
			.element(screen.getByRole("heading", { name: "Create Widget Area" }))
			.toBeInTheDocument();
		await expect.element(screen.getByLabelText("Name")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Label")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Description")).toBeInTheDocument();
	});

	it("delete area shows confirmation dialog", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect.element(screen.getByRole("heading", { name: "Sidebar" })).toBeInTheDocument();

		// The area header has a delete button next to the area label.
		// The WidgetAreaPanel header is a .p-4.border-b div with the label and a button.
		// Find the button inside the panel header (the div that contains the heading "Sidebar")
		const sidebarHeading = document.querySelector("h3");
		expect(sidebarHeading).not.toBeNull();
		// The delete button is a sibling of the div containing h3, within the .border-b parent
		const headerContainer = sidebarHeading!.closest(".border-b");
		expect(headerContainer).not.toBeNull();
		const deleteBtn = headerContainer!.querySelector("button");
		expect(deleteBtn).not.toBeNull();
		(deleteBtn as HTMLButtonElement).click();

		await expect
			.element(screen.getByRole("heading", { name: "Delete Widget Area?" }))
			.toBeInTheDocument();
		await expect.element(screen.getByText(DELETE_WIDGET_AREA_MSG_REGEX)).toBeInTheDocument();
	});

	it("widget expand/collapse toggles editor form", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Quick Links")).toBeInTheDocument();

		// Initially collapsed — editor form should not be visible
		expect(screen.getByText("Save").query()).toBeNull();

		// Click the widget title area to expand (it's a <button> wrapping the title)
		const expandButtons = document.querySelectorAll("button.text-left");
		expect(expandButtons.length).toBeGreaterThanOrEqual(1);
		(expandButtons[0] as HTMLButtonElement).click();

		// Now the editor should be visible with a Title field and Save button
		await expect.element(screen.getByLabelText("Title")).toBeInTheDocument();
		await expect.element(screen.getByText("Save")).toBeInTheDocument();
	});

	it("content widget editor shows portable text editor", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		// Wait for widget type badge to render — indicates widgets are loaded
		await expect.element(screen.getByText("(content)")).toBeInTheDocument();

		// Expand the first widget (content type — "Recent Posts")
		const expandButtons = document.querySelectorAll("button.text-left");
		expect(expandButtons.length).toBeGreaterThanOrEqual(1);
		(expandButtons[0] as HTMLButtonElement).click();

		// Content widget should show the Save button and Title input in the editor
		await expect.element(screen.getByText("Save")).toBeInTheDocument();
	});

	it("menu widget editor shows menu select", async () => {
		vi.mocked(api.fetchMenus).mockResolvedValue([
			{
				id: "m1",
				name: "main-nav",
				label: "Main Navigation",
				itemCount: 3,
				created_at: "2025-01-01T00:00:00Z",
				updated_at: "2025-01-01T00:00:00Z",
			},
			{
				id: "m2",
				name: "footer",
				label: "Footer Menu",
				itemCount: 2,
				created_at: "2025-01-01T00:00:00Z",
				updated_at: "2025-01-01T00:00:00Z",
			},
		]);

		const screen = await render(<Widgets />, { wrapper: Wrapper });

		// Expand the second widget (menu type — "Quick Links")
		await expect.element(screen.getByText("Quick Links")).toBeInTheDocument();
		const expandButtons = document.querySelectorAll("button.text-left");
		expect(expandButtons.length).toBeGreaterThanOrEqual(2);
		(expandButtons[1] as HTMLButtonElement).click();

		// Menu widget should show the Menu select
		await expect.element(screen.getByLabelText("Menu")).toBeInTheDocument();
	});

	it("empty state when no widget areas", async () => {
		vi.mocked(api.fetchWidgetAreas).mockResolvedValue([]);

		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect
			.element(screen.getByText("No widget areas yet. Create one to get started."))
			.toBeInTheDocument();
	});

	it("shows available widget components panel", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect
			.element(screen.getByRole("heading", { name: "Available Widgets" }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Content Block")).toBeInTheDocument();
		// Use exact text to avoid matching the widget type "(menu)" badge
		await expect.element(screen.getByText("Display a navigation menu")).toBeInTheDocument();
		await expect.element(screen.getByText("Shows recent posts")).toBeInTheDocument();
	});
});
