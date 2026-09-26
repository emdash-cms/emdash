import { Toasty } from "@cloudflare/kumo";
import type { DragEndEvent } from "@dnd-kit/core";
import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

import { Widgets } from "../../src/components/Widgets";
import { render } from "../utils/render";

const dndState = vi.hoisted(() => ({
	onDragEnd: null as ((event: DragEndEvent) => void) | null,
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dnd-kit/core")>();
	const ReactModule = await import("react");
	return {
		...actual,
		DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
			dndState.onDragEnd = props.onDragEnd ?? null;
			return ReactModule.createElement(actual.DndContext, props);
		},
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchWidgetAreas: vi.fn(),
		fetchWidgetComponents: vi.fn(),
		fetchMenus: vi.fn().mockResolvedValue([]),
		createWidgetArea: vi.fn().mockResolvedValue({}),
		createWidget: vi.fn().mockResolvedValue({}),
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
const ADD_WIDGET_AREA_REGEX = /Add widget area/i;

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
		dndState.onDragEnd = null;
		mockDefaults();
	});

	it("displays widget areas with labels", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect.element(screen.getByRole("heading", { name: "Sidebar" })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "About Sidebar widget area" }))
			.toBeInTheDocument();
	});

	it("shows widgets within each area", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect
			.element(screen.getByRole("button", { name: "Edit settings for Quick Links" }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Edit settings for Recent Posts" }))
			.toBeInTheDocument();
	});

	it("create area button opens dialog with name/label/description form", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: ADD_WIDGET_AREA_REGEX }).click();

		await expect
			.element(screen.getByRole("heading", { name: "Create widget area" }))
			.toBeInTheDocument();
		await expect.element(screen.getByLabelText("Name")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Label")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Description")).toBeInTheDocument();
	});

	it("delete area shows confirmation dialog", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Delete Sidebar widget area" }).click();

		await expect
			.element(screen.getByRole("heading", { name: "Delete Sidebar widget area?" }))
			.toBeInTheDocument();
		await expect.element(screen.getByText(DELETE_WIDGET_AREA_MSG_REGEX)).toBeInTheDocument();
	});

	it("adds a widget to the chosen area without dragging", async () => {
		vi.mocked(api.fetchWidgetAreas).mockResolvedValue([
			{ id: "a1", name: "sidebar", label: "Sidebar", widgets: [] },
			{ id: "a2", name: "footer", label: "Footer", widgets: [] },
		]);
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Add Content Block widget" }).click();
		await expect
			.element(screen.getByRole("heading", { name: "Add Content Block widget" }))
			.toBeInTheDocument();
		screen.getByRole("combobox", { name: "Widget area" }).element().click();
		await expect.element(screen.getByRole("option", { name: "Footer" })).toBeInTheDocument();
		screen.getByRole("option", { name: "Footer" }).element().click();
		await expect
			.element(screen.getByRole("combobox", { name: "Widget area" }))
			.toHaveTextContent("Footer");
		screen.getByRole("button", { name: "Add widget", exact: true }).element().click();

		await vi.waitFor(() => {
			expect(api.createWidget).toHaveBeenCalledWith("footer", {
				type: "content",
				title: "Content Block",
			});
		});
	});

	it("locks the selected area while adding a widget", async () => {
		vi.mocked(api.fetchWidgetAreas).mockResolvedValue([
			{ id: "a1", name: "sidebar", label: "Sidebar", widgets: [] },
			{ id: "a2", name: "footer", label: "Footer", widgets: [] },
		]);
		let resolveCreation: (widget: Awaited<ReturnType<typeof api.createWidget>>) => void = () => {};
		vi.mocked(api.createWidget).mockImplementation(
			() =>
				new Promise<Awaited<ReturnType<typeof api.createWidget>>>((resolve) => {
					resolveCreation = resolve;
				}),
		);
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Add Content Block widget" }).click();
		const areaSelect = screen.getByRole("combobox", { name: "Widget area" });
		areaSelect.element().click();
		await expect.element(screen.getByRole("option", { name: "Footer" })).toBeInTheDocument();
		screen.getByRole("option", { name: "Footer" }).element().click();
		await expect.element(areaSelect).toHaveTextContent("Footer");
		screen.getByRole("button", { name: "Add widget", exact: true }).element().click();
		await vi.waitFor(() =>
			expect(api.createWidget).toHaveBeenCalledWith("footer", {
				type: "content",
				title: "Content Block",
			}),
		);
		try {
			await expect.element(areaSelect, { timeout: 1000 }).toBeDisabled();
		} finally {
			resolveCreation({ id: "w3", type: "content", title: "Content Block" });
		}
	});

	it("keeps a dialog request visible when an earlier drag request completes", async () => {
		type CreatedWidget = Awaited<ReturnType<typeof api.createWidget>>;
		let resolveDraggedWidget: (widget: CreatedWidget) => void = () => {};
		let rejectDialogWidget: (error: Error) => void = () => {};
		vi.mocked(api.createWidget)
			.mockImplementationOnce(
				() =>
					new Promise<CreatedWidget>((resolve) => {
						resolveDraggedWidget = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<CreatedWidget>((_, reject) => {
						rejectDialogWidget = reject;
					}),
			);
		const screen = await render(<Widgets />, { wrapper: Wrapper });
		await expect.element(screen.getByRole("heading", { name: "Sidebar" })).toBeInTheDocument();

		await React.act(async () => {
			dndState.onDragEnd?.({
				active: {
					id: "palette-content",
					data: {
						current: {
							source: "palette",
							widgetInput: { type: "content", title: "Content Block" },
							label: "Content Block",
						},
					},
				},
				over: { id: "area:sidebar" },
			} as unknown as DragEndEvent);
		});
		await vi.waitFor(() => expect(api.createWidget).toHaveBeenCalledTimes(1));

		await screen.getByRole("button", { name: "Add Menu widget" }).click();
		screen.getByRole("button", { name: "Add widget", exact: true }).element().click();
		await vi.waitFor(() => expect(api.createWidget).toHaveBeenCalledTimes(2));

		resolveDraggedWidget({ id: "w3", type: "content", title: "Content Block" });
		await expect.element(screen.getByText("Widget added")).toBeVisible();
		await expect
			.element(screen.getByRole("heading", { name: "Add Menu widget" }))
			.toBeInTheDocument();
		rejectDialogWidget(new Error("Dialog creation failed"));
		await expect.element(screen.getByText("Dialog creation failed")).toBeVisible();
	});

	it("reopens the add dialog with the newly selected widget after canceling", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Add Content Block widget" }).click();
		await expect
			.element(screen.getByRole("heading", { name: "Add Content Block widget" }))
			.toBeInTheDocument();
		screen.getByRole("button", { name: "Cancel" }).element().click();
		await expect
			.element(screen.getByRole("heading", { name: "Add Content Block widget" }))
			.not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Add Menu widget" }).click();
		await expect
			.element(screen.getByRole("heading", { name: "Add Menu widget" }))
			.toBeInTheDocument();
	});

	it("confirms before deleting a widget", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Delete Quick Links" }).click();
		await expect
			.element(screen.getByRole("heading", { name: "Delete Quick Links?" }))
			.toBeInTheDocument();
		expect(api.deleteWidget).not.toHaveBeenCalled();
		screen.getByRole("button", { name: "Delete", exact: true }).element().click();

		await vi.waitFor(() => expect(api.deleteWidget).toHaveBeenCalledWith("sidebar", "w2"));
	});

	it("widget expand/collapse toggles editor form", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Quick Links")).toBeInTheDocument();

		// Initially collapsed — editor form should not be visible
		expect(screen.getByText("Save").query()).toBeNull();

		await screen.getByRole("button", { name: "Edit settings for Recent Posts" }).click();

		// Now the editor should be visible with a Title field and Save button
		await expect.element(screen.getByLabelText("Title")).toBeInTheDocument();
		await expect.element(screen.getByText("Save")).toBeInTheDocument();
	});

	it("content widget editor shows portable text editor", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect
			.element(screen.getByRole("button", { name: "Edit settings for Recent Posts" }))
			.toBeInTheDocument();

		await screen.getByRole("button", { name: "Edit settings for Recent Posts" }).click();

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

		await expect.element(screen.getByText("Quick Links")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Edit settings for Quick Links" }).click();

		// Menu widget should show the Menu select
		await expect.element(screen.getByRole("combobox", { name: "Menu" })).toBeInTheDocument();
	});

	it("empty state when no widget areas", async () => {
		vi.mocked(api.fetchWidgetAreas).mockResolvedValue([]);

		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect.element(screen.getByText("No widget areas yet")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Add Content Block widget" }))
			.toBeDisabled();
	});

	it("keeps widget descriptions accessible before an area exists", async () => {
		vi.mocked(api.fetchWidgetAreas).mockResolvedValue([]);
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect
			.element(screen.getByRole("heading", { name: "Available widgets" }))
			.toBeInTheDocument();
		await userEvent.keyboard("{Tab}");
		screen.getByRole("button", { name: "About Content Block widget" }).element().focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(screen.getByText("Rich text content"), { timeout: 1000 }).toBeVisible();
	});

	it("opens widget descriptions on press without an area", async () => {
		vi.mocked(api.fetchWidgetAreas).mockResolvedValue([]);
		const screen = await render(<Widgets />, { wrapper: Wrapper });
		await expect
			.element(screen.getByRole("heading", { name: "Available widgets" }))
			.toBeInTheDocument();

		await screen.getByRole("button", { name: "About Content Block widget" }).click();
		await expect.element(screen.getByText("Rich text content"), { timeout: 1000 }).toBeVisible();
	});

	it("opens widget-area descriptions on press", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });
		await expect.element(screen.getByRole("heading", { name: "Sidebar" })).toBeInTheDocument();

		await screen.getByRole("button", { name: "About Sidebar widget area" }).click();
		await expect.element(screen.getByText("Main sidebar"), { timeout: 1000 }).toBeVisible();
	});

	it("shows available widget components panel", async () => {
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await expect
			.element(screen.getByRole("heading", { name: "Available widgets" }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Content Block")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Add Recent Posts Widget widget" }))
			.toBeInTheDocument();
		await screen.getByRole("button", { name: "Add Recent Posts Widget widget" }).click();
		await expect.element(screen.getByText("Shows recent posts")).toBeVisible();
	});

	it("searches a large widget library by description", async () => {
		vi.mocked(api.fetchWidgetComponents).mockResolvedValue(
			Array.from({ length: 30 }, (_, index) => ({
				id: `custom:${index}`,
				label: `Widget ${index}`,
				description: index === 29 ? "Audio feed" : `Widget ${index} description`,
				props: {},
			})),
		);
		const screen = await render(<Widgets />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Search widgets" }).click();
		await screen.getByRole("searchbox", { name: "Search widgets" }).fill("audio feed");
		await expect
			.element(screen.getByRole("button", { name: "Add Widget 29 widget" }))
			.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add Widget 0 widget" }).query()).toBeNull();

		await screen.getByRole("button", { name: "Close widget search" }).click();
		await expect
			.element(screen.getByRole("button", { name: "Add Widget 0 widget" }))
			.toBeInTheDocument();
	});

	it("searches widget labels with the admin locale", async () => {
		const previousLocale = i18n.locale;
		i18n.load("tr", {});
		i18n.activate("tr");
		vi.mocked(api.fetchWidgetComponents).mockResolvedValue(
			Array.from({ length: 7 }, (_, index) => ({
				id: `custom:${index}`,
				label: index === 6 ? "İçerik Bloğu" : `Widget ${index}`,
				props: {},
			})),
		);

		try {
			const screen = await render(<Widgets />, { wrapper: Wrapper });
			await screen.getByRole("button", { name: "Search widgets" }).click();
			await screen.getByRole("searchbox", { name: "Search widgets" }).fill("içerik");
			await expect
				.element(screen.getByRole("button", { name: "Add İçerik Bloğu widget" }), {
					timeout: 1000,
				})
				.toBeInTheDocument();
		} finally {
			i18n.activate(previousLocale);
		}
	});
});
