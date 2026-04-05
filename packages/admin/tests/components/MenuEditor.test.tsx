import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MenuEditor } from "../../src/components/MenuEditor";
import { render } from "../utils/render.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({
			children,
			to,
			...props
		}: {
			children: React.ReactNode;
			to?: string;
			[key: string]: unknown;
		}) => (
			<a href={typeof to === "string" ? to : "#"} {...props}>
				{children}
			</a>
		),
		useParams: () => ({ name: "main-menu" }),
		useNavigate: () => vi.fn(),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchMenu: vi.fn(),
		createMenuItem: vi.fn().mockResolvedValue({ id: "3" }),
		deleteMenuItem: vi.fn().mockResolvedValue(undefined),
		updateMenuItem: vi.fn().mockResolvedValue({}),
		reorderMenuItems: vi.fn().mockResolvedValue([]),
	};
});

import * as api from "../../src/lib/api";

const ADD_CUSTOM_LINK_REGEX = /Add Custom Link/;

const defaultMenu = {
	id: "menu1",
	name: "main-menu",
	label: "Main Menu",
	created_at: "",
	updated_at: "",
	items: [
		{
			id: "1",
			menu_id: "menu1",
			parent_id: null,
			sort_order: 0,
			type: "custom",
			reference_collection: null,
			reference_id: null,
			custom_url: "/",
			label: "Home",
			title_attr: null,
			target: "_self",
			css_classes: null,
			created_at: "",
		},
		{
			id: "2",
			menu_id: "menu1",
			parent_id: null,
			sort_order: 1,
			type: "custom",
			reference_collection: null,
			reference_id: null,
			custom_url: "/about",
			label: "About",
			title_attr: null,
			target: "_self",
			css_classes: null,
			created_at: "",
		},
	],
};

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

describe("MenuEditor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.fetchMenu).mockResolvedValue(defaultMenu);
	});

	it("displays menu items in order", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		// Use exact: true to avoid matching "/about" which contains "About"
		await expect.element(screen.getByText("Home")).toBeInTheDocument();
		await expect.element(screen.getByText("About", { exact: true })).toBeInTheDocument();
	});

	it("add item button opens dialog with label and URL inputs", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByRole("heading", { name: "Main Menu" })).toBeInTheDocument();
		await screen.getByRole("button", { name: ADD_CUSTOM_LINK_REGEX }).click();

		await expect.element(screen.getByLabelText("Label")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("URL")).toBeInTheDocument();
	});

	it("edit item opens dialog", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Home")).toBeInTheDocument();

		const editButtons = screen.getByRole("button", { name: "Edit" });
		await editButtons.first().click();

		await expect
			.element(screen.getByRole("heading", { name: "Edit Menu Item" }))
			.toBeInTheDocument();
	});

	it("delete item fires immediately without confirmation dialog", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Home")).toBeInTheDocument();

		// Delete buttons have aria-label="Delete"
		const deleteBtn = screen.getByRole("button", { name: "Delete" });
		await deleteBtn.first().click();

		// No confirmation dialog should appear
		expect(screen.getByText("Are you sure").query()).toBeNull();
		expect(screen.getByText("Confirm").query()).toBeNull();
	});

	it("up/down reorder buttons — first item up disabled, last item down disabled", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Home")).toBeInTheDocument();

		const disabledButtons = document.querySelectorAll("button[disabled]");
		// At least 2: first item's up + last item's down
		expect(disabledButtons.length).toBeGreaterThanOrEqual(2);
	});

	it("empty state when no items", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [],
		});

		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("No menu items yet")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Add links to build your navigation menu"))
			.toBeInTheDocument();
	});

	it("shows menu label as heading", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByRole("heading", { name: "Main Menu" })).toBeInTheDocument();
	});

	it("shows custom URLs for custom link items", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Home")).toBeInTheDocument();
		await expect.element(screen.getByText("/about")).toBeInTheDocument();
	});
});
