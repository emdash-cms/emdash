import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { MenuEditor } from "../../src/components/MenuEditor";
import type { MenuItem, MenuWithItems } from "../../src/lib/api";
import { pressOutside } from "../utils/mouse.ts";
import { render } from "../utils/render.tsx";

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
		useSearch: () => ({}),
		useNavigate: () => vi.fn(),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchMenu: vi.fn(),
		updateMenu: vi.fn(),
		createMenuItem: vi.fn().mockResolvedValue({ id: "3" }),
		deleteMenuItem: vi.fn().mockResolvedValue(undefined),
		updateMenuItem: vi.fn().mockResolvedValue({}),
		reorderMenuItems: vi.fn().mockResolvedValue([]),
		fetchCollections: vi.fn().mockResolvedValue([{ slug: "pages", label: "Pages" }]),
		fetchContentList: vi.fn().mockResolvedValue({
			items: [
				{
					id: "page-1",
					type: "pages",
					slug: "pricing",
					status: "published",
					locale: "en",
					translationGroup: "page-1",
					data: { title: "Pricing" },
					liveRevisionId: "rev-1",
					draftRevisionId: null,
				},
			],
		}),
		fetchManifest: vi.fn().mockResolvedValue({ collections: {} }),
		fetchTaxonomyDefs: vi.fn().mockResolvedValue([]),
		fetchTerms: vi.fn().mockResolvedValue([]),
		fetchContent: vi.fn().mockRejectedValue(new Error("Not found")),
		fetchTrashedContent: vi.fn().mockResolvedValue({ items: [] }),
	};
});

import * as api from "../../src/lib/api";

const ABOUT_DELETE_MSG_REGEX = /"About" will be removed from this menu/;
const HOME_NESTED_DELETE_MSG_REGEX = /"Home" and its nested items will be removed from this menu/;
const SERVICES_DELETE_MSG_REGEX = /"Services" will be removed from this menu/;
const BAD_URL = "Enter a URL that starts with https://, http://, mailto:, tel:, /, or #.";
const SINGLE_SLASH = "Enter a path that starts with a single /.";

const defaultMenu = {
	id: "menu1",
	name: "main-menu",
	label: "Main Menu",
	createdAt: "",
	updatedAt: "",
	locale: "en",
	translationGroup: "menu1",
	items: [
		{
			id: "1",
			menuId: "menu1",
			parentId: null,
			sortOrder: 0,
			type: "custom",
			referenceCollection: null,
			referenceId: null,
			customUrl: "/",
			label: "Home",
			titleAttr: null,
			target: "_self",
			cssClasses: null,
			createdAt: "",
			locale: "en",
			translationGroup: "1",
		},
		{
			id: "2",
			menuId: "menu1",
			parentId: null,
			sortOrder: 1,
			type: "custom",
			referenceCollection: null,
			referenceId: null,
			customUrl: "/about",
			label: "About",
			titleAttr: null,
			target: "_self",
			cssClasses: null,
			createdAt: "",
			locale: "en",
			translationGroup: "2",
		},
	],
};

const services = {
	...defaultMenu.items[0]!,
	id: "3",
	parentId: "1",
	sortOrder: 0,
	customUrl: "/services",
	label: "Services",
	translationGroup: "3",
};

type Screen = Awaited<ReturnType<typeof render>>;

async function chooseFromRowMenu(screen: Screen, label: string, action: string) {
	await screen.getByRole("button", { name: `Actions for ${label}` }).click();
	await screen
		.getByRole("menu", { name: `Actions for ${label}` })
		.getByRole("menuitem", { name: action })
		.click();
}

function rowIds() {
	return Array.from(document.querySelectorAll("[data-menu-item-id]"), (row) =>
		row.getAttribute("data-menu-item-id"),
	);
}

async function openAddCustomLink(screen: Screen) {
	await screen.getByRole("button", { name: "Add items" }).click();
	const dialog = screen.getByRole("dialog", { name: "Add items" });
	dialog.getByRole("combobox", { name: "Source" }).element().click();
	await screen.getByRole("option", { name: "Custom link" }).click();
	return dialog;
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

describe("MenuEditor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		vi.mocked(api.fetchMenu).mockResolvedValue(defaultMenu);
	});

	it("displays menu items in order", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		// Use exact: true to avoid matching "/about" which contains "About"
		await expect.element(screen.getByText("Home")).toBeInTheDocument();
		await expect.element(screen.getByText("About", { exact: true })).toBeInTheDocument();
	});

	it("add items opens a dialog with label and URL inputs for a custom link", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByRole("heading", { name: "Main Menu" })).toBeInTheDocument();
		const dialog = await openAddCustomLink(screen);

		await expect
			.element(dialog)
			.toHaveAccessibleDescription("Pick from any source, then add them all at once.");
		await expect.element(dialog.getByLabelText("Label")).toBeInTheDocument();
		await expect.element(dialog.getByLabelText("URL")).toBeInTheDocument();
	});

	it("opens Edit when a row is pressed", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Home", exact: true }).click();

		await expect
			.element(screen.getByRole("dialog", { name: "Edit menu item" }))
			.toHaveAccessibleDescription("Change how this item shows in the menu.");
	});

	it("asks for confirmation before deleting a menu item", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await chooseFromRowMenu(screen, "About", "Delete");

		const dialog = screen.getByRole("dialog", { name: "Delete menu item?" });
		await expect.element(dialog.getByText(ABOUT_DELETE_MSG_REGEX)).toBeInTheDocument();
		expect(api.deleteMenuItem).not.toHaveBeenCalled();

		dialog.getByRole("button", { name: "Delete" }).element().click();

		await vi.waitFor(() =>
			expect(api.deleteMenuItem).toHaveBeenCalledWith("main-menu", "2", { locale: "en" }),
		);
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("keeps the confirmation open with the error when deleting a menu item fails", async () => {
		vi.mocked(api.deleteMenuItem).mockRejectedValueOnce(new Error("Menu item not found"));
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await chooseFromRowMenu(screen, "About", "Delete");
		const dialog = screen.getByRole("dialog", { name: "Delete menu item?" });
		await expect.element(dialog).toBeInTheDocument();
		dialog.getByRole("button", { name: "Delete" }).element().click();

		await expect.element(dialog.getByRole("alert")).toHaveTextContent("Menu item not found");
	});

	it("says nested items are deleted too only for an item that has them", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [...defaultMenu.items, services],
		});
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Services", { exact: true })).toBeInTheDocument();
		await chooseFromRowMenu(screen, "Home", "Delete");
		const dialog = screen.getByRole("dialog", { name: "Delete menu item?" });
		await expect.element(dialog.getByText(HOME_NESTED_DELETE_MSG_REGEX)).toBeInTheDocument();

		dialog.getByRole("button", { name: "Cancel" }).element().click();
		await expect.element(dialog).not.toBeInTheDocument();

		await chooseFromRowMenu(screen, "Services", "Delete");
		await expect.element(dialog.getByText(SERVICES_DELETE_MSG_REGEX)).toBeInTheDocument();
	});

	it("offers only the moves the row's place allows", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Actions for Home" }).click();
		await expect.element(screen.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
		await expect.element(screen.getByRole("menuitem", { name: "Indent" })).toBeDisabled();
		await expect.element(screen.getByRole("menuitem", { name: "Outdent" })).toBeDisabled();
		await expect.element(screen.getByRole("menuitem", { name: "Move down" })).toBeEnabled();
	});

	it("indents an item under the one above it in a single reorder", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await chooseFromRowMenu(screen, "About", "Indent");

		await vi.waitFor(() =>
			expect(api.reorderMenuItems).toHaveBeenCalledWith(
				"main-menu",
				{
					items: [
						{ id: "1", parentId: null, sortOrder: 0 },
						{ id: "2", parentId: "1", sortOrder: 0 },
					],
				},
				{ locale: "en" },
			),
		);
		expect(api.reorderMenuItems).toHaveBeenCalledTimes(1);
	});

	it("puts the old order back, says so, and reloads the menu when a reorder fails", async () => {
		vi.mocked(api.reorderMenuItems).mockRejectedValueOnce(new Error("Reorder refused"));
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });
		await expect.element(screen.getByText("Home")).toBeInTheDocument();
		const reload = Promise.withResolvers<MenuWithItems>();
		vi.mocked(api.fetchMenu).mockReturnValueOnce(reload.promise);

		await chooseFromRowMenu(screen, "About", "Move up");

		await expect.element(screen.getByText("Couldn’t save the new order")).toBeVisible();
		await expect.element(screen.getByText("Reorder refused")).toBeVisible();
		await vi.waitFor(() => expect(rowIds()).toEqual(["1", "2"]));
		await vi.waitFor(() => expect(api.fetchMenu).toHaveBeenCalledTimes(2));

		const [home, about] = defaultMenu.items;
		reload.resolve({
			...defaultMenu,
			items: [
				{ ...about!, sortOrder: 0 },
				{ ...home!, sortOrder: 1 },
			],
		});
		await vi.waitFor(() => expect(rowIds()).toEqual(["2", "1"]));
	});

	it("sends quick moves one at a time and reloads after the last when one fails", async () => {
		const contact = {
			...defaultMenu.items[1]!,
			id: "4",
			sortOrder: 2,
			customUrl: "/contact",
			label: "Contact",
			translationGroup: "4",
		};
		let saved: MenuItem[] = [...defaultMenu.items, contact];
		vi.mocked(api.fetchMenu).mockImplementation(async () => ({ ...defaultMenu, items: saved }));
		const first = Promise.withResolvers<MenuItem[]>();
		const second = Promise.withResolvers<void>();
		vi.mocked(api.reorderMenuItems)
			.mockReturnValueOnce(first.promise)
			.mockImplementationOnce(async (_name, input) => {
				await second.promise;
				const byId = new Map(saved.map((item) => [item.id, item]));
				saved = input.items.map(({ id, parentId, sortOrder }) => ({
					...byId.get(id)!,
					parentId,
					sortOrder,
				}));
				return saved;
			});
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await chooseFromRowMenu(screen, "Contact", "Move up");
		await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
		await chooseFromRowMenu(screen, "Contact", "Move up");
		await vi.waitFor(() => expect(rowIds()).toEqual(["4", "1", "2"]));
		expect(api.reorderMenuItems).toHaveBeenCalledTimes(1);

		first.reject(new Error("Reorder refused"));
		await expect.element(screen.getByText("Couldn’t save the new order")).toBeVisible();
		await vi.waitFor(() => expect(rowIds()).toEqual(["1", "2", "4"]));
		await vi.waitFor(() => expect(api.reorderMenuItems).toHaveBeenCalledTimes(2));
		expect(api.fetchMenu).toHaveBeenCalledTimes(1);

		second.resolve();
		await vi.waitFor(() => expect(api.fetchMenu).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(rowIds()).toEqual(["4", "1", "2"]));
	});

	it("nests an item with the keyboard and keeps focus on its handle", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const handle = screen.getByRole("button", { name: "Move About" });
		await expect.element(handle).toBeInTheDocument();
		handle.element().focus();
		await userEvent.keyboard(" ");
		await userEvent.keyboard("{ArrowRight}");
		await userEvent.keyboard(" ");

		await vi.waitFor(() =>
			expect(api.reorderMenuItems).toHaveBeenCalledWith(
				"main-menu",
				{
					items: [
						{ id: "1", parentId: null, sortOrder: 0 },
						{ id: "2", parentId: "1", sortOrder: 0 },
					],
				},
				{ locale: "en" },
			),
		);
		await expect.element(screen.getByRole("button", { name: "Move About" })).toHaveFocus();
	});

	it("empty state when no items", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [],
		});

		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("No menu items yet")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Add pages, posts, categories, or links to build this menu."))
			.toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Add items" })).toBeInTheDocument();
	});

	it("shows menu label as heading", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByRole("heading", { name: "Main Menu" })).toBeInTheDocument();
	});

	it("renames the menu and shows the new label", async () => {
		vi.mocked(api.updateMenu).mockImplementation(async (_name, input) => {
			const renamed = { ...defaultMenu, label: input.label ?? "" };
			vi.mocked(api.fetchMenu).mockResolvedValue(renamed);
			return renamed;
		});
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Rename menu" }).click();
		await expect
			.element(screen.getByRole("dialog", { name: "Rename menu" }))
			.toHaveAccessibleDescription("Give this menu a new label.");
		const labelInput = screen.getByLabelText("Label", { exact: true });
		await expect.element(labelInput).toHaveValue("Main Menu");
		await labelInput.fill("Footer links");
		screen.getByRole("button", { name: "Save" }).element().click();

		await expect
			.element(screen.getByRole("heading", { name: "Footer links", level: 1 }))
			.toBeInTheDocument();
		expect(api.updateMenu).toHaveBeenCalledWith(
			"main-menu",
			{ label: "Footer links" },
			{ locale: "en" },
		);
	});

	it("adds staged custom links and headings in order, with one toast", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const dialog = await openAddCustomLink(screen);
		await dialog.getByLabelText("Label").fill("Book a demo");
		await dialog.getByLabelText("URL").fill(" /contact ");
		await dialog.getByRole("button", { name: "Add to list" }).click();
		dialog.getByRole("combobox", { name: "Source" }).element().click();
		await screen.getByRole("option", { name: "Heading" }).click();
		await dialog.getByLabelText("Label").fill("More");
		await dialog.getByRole("button", { name: "Add to list" }).click();
		await expect.element(dialog.getByText("2 selected")).toBeVisible();
		await dialog.getByRole("button", { name: "Add 2 items" }).click();

		await expect.element(screen.getByText("Added 2 items")).toBeVisible();
		expect(vi.mocked(api.createMenuItem).mock.calls.map((call) => call[1])).toEqual([
			{ type: "custom", label: "Book a demo", customUrl: "/contact", parentId: undefined },
			{ type: "custom", label: "More", parentId: undefined },
		]);
	});

	it("adds inside the row its menu was opened from", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await chooseFromRowMenu(screen, "Home", "Add item inside");
		const dialog = screen.getByRole("dialog", { name: "Add items" });
		await expect
			.element(dialog.getByRole("combobox", { name: "Add to" }))
			.toHaveTextContent("Home");
		dialog.getByRole("combobox", { name: "Source" }).element().click();
		await screen.getByRole("option", { name: "Heading" }).click();
		await dialog.getByLabelText("Label").fill("Team");
		await dialog.getByRole("button", { name: "Add to list" }).click();
		await dialog.getByRole("button", { name: "Add 1 item" }).click();

		await vi.waitFor(() =>
			expect(api.createMenuItem).toHaveBeenCalledWith(
				"main-menu",
				{ type: "custom", label: "Team", parentId: "1" },
				{ locale: "en" },
			),
		);
	});

	it("clears a menu item's CSS classes", async () => {
		const [home, about] = defaultMenu.items;
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [{ ...home!, cssClasses: "button" }, about!],
		});
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Home")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Home", exact: true }).click();
		const classesInput = screen.getByLabelText("CSS classes", { exact: true });
		await expect.element(classesInput).toHaveValue("button");
		await classesInput.fill("");
		screen.getByRole("button", { name: "Save" }).element().click();

		await vi.waitFor(() =>
			expect(api.updateMenuItem).toHaveBeenCalledWith(
				"main-menu",
				"1",
				expect.objectContaining({ cssClasses: "" }),
				{ locale: "en" },
			),
		);
	});

	it("shows custom URLs for custom link items", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Home")).toBeInTheDocument();
		await expect.element(screen.getByText("/about")).toBeInTheDocument();
	});

	it("points at each missing custom link field when staged, and stages nothing", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const dialog = await openAddCustomLink(screen);
		expect(dialog.getByText("Enter a label.").query()).toBeNull();
		await dialog.getByRole("button", { name: "Add to list" }).click();

		const label = dialog.getByRole("textbox", { name: "Label", exact: true });
		await expect.element(dialog.getByText("Enter a label.")).toBeVisible();
		await expect.element(dialog.getByText("Enter a URL.")).toBeVisible();
		await expect.element(label).toHaveAttribute("aria-invalid", "true");
		await expect
			.element(dialog.getByRole("textbox", { name: "URL", exact: true }))
			.toHaveAttribute("aria-invalid", "true");
		await expect.element(label).toHaveFocus();
		await expect.element(dialog.getByText("0 selected")).toBeVisible();

		await label.fill("Pricing");
		await expect.element(dialog.getByText("Enter a label.")).not.toBeInTheDocument();
	});

	it("refuses the links the server refuses", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const dialog = await openAddCustomLink(screen);
		const url = dialog.getByRole("textbox", { name: "URL", exact: true });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Partner");
		for (const [value, message] of [
			["example.com", BAD_URL],
			["//partner.example", SINGLE_SLASH],
			["javascript:alert(1)", BAD_URL],
			["/\\evil", SINGLE_SLASH],
		]) {
			await url.fill(value);
			await dialog.getByRole("button", { name: "Add to list" }).click();
			await expect.element(dialog.getByText(message)).toBeVisible();
			await expect.element(url).toHaveFocus();
		}
		await expect.element(dialog.getByText("0 selected")).toBeVisible();
	});

	it.each([
		"/about",
		"https://example.com",
		"mailto:hello@example.com",
		"tel:+15551234567",
		"#top",
	])("accepts %s as a link", async (value) => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const dialog = await openAddCustomLink(screen);
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Link");
		await dialog.getByRole("textbox", { name: "URL", exact: true }).fill(` ${value} `);
		await dialog.getByRole("button", { name: "Add to list" }).click();
		await dialog.getByRole("button", { name: "Add 1 item" }).click();

		await vi.waitFor(() =>
			expect(vi.mocked(api.createMenuItem).mock.calls[0]?.[1]).toMatchObject({
				type: "custom",
				customUrl: value,
			}),
		);
	});

	it("asks for a label when the menu is renamed to blank, and sends nothing", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Rename menu" }).click();
		const dialog = screen.getByRole("dialog", { name: "Rename menu" });
		const label = dialog.getByRole("textbox", { name: "Label", exact: true });
		await label.fill("   ");
		await dialog.getByRole("button", { name: "Save" }).click();

		await expect.element(dialog.getByText("Enter a label.")).toBeVisible();
		await expect.element(label).toHaveAttribute("aria-invalid", "true");
		await expect.element(label).toHaveFocus();
		expect(api.updateMenu).not.toHaveBeenCalled();
	});

	it("points at a cleared label and an unsafe URL when editing an item", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "About", exact: true }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit menu item" });
		const label = dialog.getByRole("textbox", { name: "Label", exact: true });
		await label.fill("");
		await dialog.getByRole("textbox", { name: "URL", exact: true }).fill("//partner.example");
		await dialog.getByRole("button", { name: "Save" }).click();

		await expect.element(dialog.getByText("Enter a label.")).toBeVisible();
		await expect.element(dialog.getByText(SINGLE_SLASH)).toBeVisible();
		await expect.element(label).toHaveFocus();
		expect(api.updateMenuItem).not.toHaveBeenCalled();
	});

	it("does not show one item's failed save when another item opens", async () => {
		vi.mocked(api.updateMenuItem).mockRejectedValueOnce(new Error("Menu item not found"));
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "About", exact: true }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit menu item" });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("About us");
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect.element(dialog.getByRole("alert")).toHaveTextContent("Menu item not found");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Home", exact: true }).click();
		await expect
			.element(
				screen.getByRole("dialog", { name: "Edit menu item" }).getByRole("textbox", {
					name: "Label",
					exact: true,
				}),
			)
			.toHaveValue("Home");
		expect(screen.getByRole("dialog").getByRole("alert").query()).toBeNull();
	});

	it("keeps Add items open with the error when an item can't be added", async () => {
		vi.mocked(api.createMenuItem).mockRejectedValueOnce(new Error("Pricing could not be added"));
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const dialog = await openAddCustomLink(screen);
		await dialog.getByLabelText("Label").fill("Pricing");
		await dialog.getByLabelText("URL").fill("/pricing");
		await dialog.getByRole("button", { name: "Add to list" }).click();
		await dialog.getByRole("button", { name: "Add 1 item" }).click();

		await expect.element(dialog.getByRole("alert")).toHaveTextContent("Pricing could not be added");
		await expect.element(dialog.getByText("1 selected")).toBeVisible();
	});

	it("keeps a typed custom link through a press outside, and still closes on Cancel", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const dialog = await openAddCustomLink(screen);
		await dialog.getByRole("textbox", { name: "URL", exact: true }).fill("/pricing");

		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect
			.element(dialog.getByRole("textbox", { name: "URL", exact: true }))
			.toHaveValue("/pricing");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("closes Add items on a press outside when nothing was picked or typed", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const dialog = await openAddCustomLink(screen);
		await expect.element(dialog).toBeVisible();

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("keeps item and rename edits through a press outside, and closes untouched ones", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Home", exact: true }).click();
		const edit = screen.getByRole("dialog", { name: "Edit menu item" });
		await expect.element(edit).toBeVisible();
		await pressOutside();
		await expect.element(edit).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Home", exact: true }).click();
		await edit.getByRole("textbox", { name: "Label", exact: true }).fill("Start");
		await pressOutside();
		await expect.element(edit).toBeVisible();
		await edit.getByRole("button", { name: "Cancel" }).click();
		await expect.element(edit).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Rename menu" }).click();
		const rename = screen.getByRole("dialog", { name: "Rename menu" });
		await rename.getByRole("textbox", { name: "Label", exact: true }).fill("Footer links");
		await pressOutside();
		await expect.element(rename).toBeVisible();
	});

	it("renders nested items indented under their parent", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [...defaultMenu.items, services],
		});

		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const label = screen.getByRole("button", { name: "Services", exact: true });
		await expect.element(label).toBeInTheDocument();
		expect(label.element().parentElement?.style.paddingInlineStart).toBe("24px");
	});

	it("treats an item whose parent is missing as a top-level item", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [...defaultMenu.items, { ...services, parentId: "deleted-parent" }],
		});

		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const label = screen.getByRole("button", { name: "Services", exact: true });
		await expect.element(label).toBeInTheDocument();
		expect(label.element().parentElement?.style.paddingInlineStart).toBe("0px");
		await screen.getByRole("button", { name: "Actions for Services" }).click();
		await expect.element(screen.getByRole("menuitem", { name: "Move up" })).toBeEnabled();
	});

	it("moves an item only among its siblings, not the whole flat list", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [...defaultMenu.items, services],
		});

		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		// "Services" is Home's only child, so it can't move up or down even
		// though it isn't the first or last row.
		await screen.getByRole("button", { name: "Actions for Services" }).click();
		await expect.element(screen.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
		await expect.element(screen.getByRole("menuitem", { name: "Move down" })).toBeDisabled();
		await expect.element(screen.getByRole("menuitem", { name: "Outdent" })).toBeEnabled();
	});
});
