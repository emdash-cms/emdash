import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import "../../dist/styles.css";
import { MenuEditor } from "../../src/components/MenuEditor";
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
	};
});

import * as api from "../../src/lib/api";

const ADD_CUSTOM_LINK_REGEX = /Add Custom Link/;
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

	it("links back to the menus list", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const backLink = screen.getByRole("link", { name: "Back to menus" });
		await expect.element(backLink).toHaveAttribute("href", "/menus");
		await expect.element(backLink).toHaveTextContent(/^Back$/);
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

		await expect
			.element(screen.getByRole("dialog", { name: "Add Custom Link" }))
			.toHaveAccessibleDescription("Link to any page by its address, on this site or another.");
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
		await expect
			.element(screen.getByRole("dialog", { name: "Edit Menu Item" }))
			.toHaveAccessibleDescription("Change this item's label, link and place in the menu.");
	});

	it("asks for confirmation before deleting a menu item", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("About", { exact: true })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Delete" }).nth(1).click();

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

		await expect.element(screen.getByText("About", { exact: true })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Delete" }).nth(1).click();
		const dialog = screen.getByRole("dialog", { name: "Delete menu item?" });
		await expect.element(dialog).toBeInTheDocument();
		dialog.getByRole("button", { name: "Delete" }).element().click();

		await expect.element(dialog.getByRole("alert")).toHaveTextContent("Menu item not found");
	});

	it("says nested items are deleted too only for an item that has them", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [
				...defaultMenu.items,
				{
					id: "3",
					menuId: "menu1",
					parentId: "1",
					sortOrder: 0,
					type: "custom",
					referenceCollection: null,
					referenceId: null,
					customUrl: "/services",
					label: "Services",
					titleAttr: null,
					target: "_self",
					cssClasses: null,
					createdAt: "",
					locale: "en",
					translationGroup: "3",
				},
			],
		});
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Services", { exact: true })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Delete" }).nth(0).click();
		const dialog = screen.getByRole("dialog", { name: "Delete menu item?" });
		await expect.element(dialog.getByText(HOME_NESTED_DELETE_MSG_REGEX)).toBeInTheDocument();

		dialog.getByRole("button", { name: "Cancel" }).element().click();
		await expect.element(dialog).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Delete" }).nth(1).click();
		await expect.element(dialog.getByText(SERVICES_DELETE_MSG_REGEX)).toBeInTheDocument();
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

	it("adds a custom link with trimmed CSS classes", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: ADD_CUSTOM_LINK_REGEX }).click();
		await screen.getByLabelText("Label").fill("Book a demo");
		await screen.getByLabelText("URL").fill("/contact");
		await screen.getByLabelText("CSS classes", { exact: true }).fill(" button ");
		screen.getByRole("button", { name: "Add", exact: true }).element().click();

		await vi.waitFor(() =>
			expect(api.createMenuItem).toHaveBeenCalledWith(
				"main-menu",
				expect.objectContaining({ label: "Book a demo", cssClasses: "button" }),
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
		await screen.getByRole("button", { name: "Edit" }).first().click();
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

	it("points at each missing custom link field when submitted, and sends nothing", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: ADD_CUSTOM_LINK_REGEX }).click();
		const dialog = screen.getByRole("dialog", { name: "Add Custom Link" });
		expect(dialog.getByText("Enter a label.").query()).toBeNull();
		await dialog.getByRole("button", { name: "Add", exact: true }).click();

		const label = dialog.getByRole("textbox", { name: "Label", exact: true });
		await expect.element(dialog.getByText("Enter a label.")).toBeVisible();
		await expect.element(dialog.getByText("Enter a URL.")).toBeVisible();
		await expect.element(label).toHaveAttribute("aria-invalid", "true");
		await expect
			.element(dialog.getByRole("textbox", { name: "URL", exact: true }))
			.toHaveAttribute("aria-invalid", "true");
		await expect.element(label).toHaveFocus();
		expect(api.createMenuItem).not.toHaveBeenCalled();

		await label.fill("Pricing");
		await expect.element(dialog.getByText("Enter a label.")).not.toBeInTheDocument();
	});

	it("refuses the links the server refuses", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: ADD_CUSTOM_LINK_REGEX }).click();
		const dialog = screen.getByRole("dialog", { name: "Add Custom Link" });
		const url = dialog.getByRole("textbox", { name: "URL", exact: true });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Partner");
		for (const [value, message] of [
			["example.com", BAD_URL],
			["//partner.example", SINGLE_SLASH],
			["javascript:alert(1)", BAD_URL],
			["/\\evil", SINGLE_SLASH],
		]) {
			await url.fill(value);
			await dialog.getByRole("button", { name: "Add", exact: true }).click();
			await expect.element(dialog.getByText(message)).toBeVisible();
			await expect.element(url).toHaveFocus();
		}
		expect(api.createMenuItem).not.toHaveBeenCalled();
	});

	it.each([
		"/about",
		"https://example.com",
		"mailto:hello@example.com",
		"tel:+15551234567",
		"#top",
	])("accepts %s as a link", async (value) => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: ADD_CUSTOM_LINK_REGEX }).click();
		const dialog = screen.getByRole("dialog", { name: "Add Custom Link" });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Link");
		await dialog.getByRole("textbox", { name: "URL", exact: true }).fill(` ${value} `);
		await dialog.getByRole("button", { name: "Add", exact: true }).click();

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

		await expect.element(screen.getByText("About", { exact: true })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Edit" }).nth(1).click();
		const dialog = screen.getByRole("dialog", { name: "Edit Menu Item" });
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

		await expect.element(screen.getByText("About", { exact: true })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Edit" }).nth(1).click();
		const dialog = screen.getByRole("dialog", { name: "Edit Menu Item" });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("About us");
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect.element(dialog.getByRole("alert")).toHaveTextContent("Menu item not found");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Edit" }).first().click();
		await expect
			.element(
				screen.getByRole("dialog", { name: "Edit Menu Item" }).getByRole("textbox", {
					name: "Label",
					exact: true,
				}),
			)
			.toHaveValue("Home");
		expect(screen.getByRole("dialog").getByRole("alert").query()).toBeNull();
	});

	it("reports a failed content item add by toast, not in Add Custom Link", async () => {
		vi.mocked(api.createMenuItem).mockRejectedValueOnce(new Error("Pricing could not be added"));
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Add Content" }).click();
		await screen.getByRole("button", { name: /Pricing/ }).click();

		await expect.element(screen.getByText("Couldn’t add the menu item")).toBeVisible();
		expect(vi.mocked(api.createMenuItem).mock.calls[0]?.[1]).toMatchObject({
			type: "page",
			referenceId: "page-1",
		});

		await screen.getByRole("button", { name: ADD_CUSTOM_LINK_REGEX }).click();
		const dialog = screen.getByRole("dialog", { name: "Add Custom Link" });
		await expect.element(dialog).toBeVisible();
		expect(dialog.getByRole("alert").query()).toBeNull();
	});

	it("keeps a typed custom link through a press outside, and still closes on Cancel", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: ADD_CUSTOM_LINK_REGEX }).click();
		const dialog = screen.getByRole("dialog", { name: "Add Custom Link" });
		await dialog.getByRole("textbox", { name: "URL", exact: true }).fill("/pricing");

		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect
			.element(dialog.getByRole("textbox", { name: "URL", exact: true }))
			.toHaveValue("/pricing");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("closes Add Custom Link on a press outside when nothing was typed", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: ADD_CUSTOM_LINK_REGEX }).click();
		const dialog = screen.getByRole("dialog", { name: "Add Custom Link" });
		await expect.element(dialog).toBeVisible();

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("keeps item and rename edits through a press outside, and closes untouched ones", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("About", { exact: true })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Edit" }).first().click();
		const edit = screen.getByRole("dialog", { name: "Edit Menu Item" });
		await expect.element(edit).toBeVisible();
		await pressOutside();
		await expect.element(edit).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Edit" }).first().click();
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

	it("edit dialog shows a Parent select that excludes the item itself", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Home")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Edit" }).first().click();

		await expect
			.element(screen.getByRole("heading", { name: "Edit Menu Item" }))
			.toBeInTheDocument();
		// Use a native DOM click rather than a Playwright locator click: this
		// env doesn't load Tailwind CSS, so the Dialog's `fixed` positioning
		// class has no effect and Base UI's outside-click-capture layer (styled
		// via inline `position: fixed`) stacks on top per normal paint order,
		// failing Playwright's pointer-event hit test on the trigger.
		screen.getByRole("combobox", { name: "Parent" }).element().click();

		await expect.element(screen.getByRole("option", { name: "About" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Home", exact: true }).query()).toBeNull();
	});

	it("edit dialog's Parent select excludes descendants to prevent cycles", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [
				...defaultMenu.items,
				{
					id: "3",
					menuId: "menu1",
					parentId: "1",
					sortOrder: 0,
					type: "custom",
					referenceCollection: null,
					referenceId: null,
					customUrl: "/services",
					label: "Services",
					titleAttr: null,
					target: "_self",
					cssClasses: null,
					createdAt: "",
					locale: "en",
					translationGroup: "3",
				},
			],
		});

		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Home")).toBeInTheDocument();
		// Home is the first row; editing it must exclude its own child (Services)
		// from the Parent options, not just itself.
		await screen.getByRole("button", { name: "Edit" }).first().click();

		await expect
			.element(screen.getByRole("heading", { name: "Edit Menu Item" }))
			.toBeInTheDocument();
		screen.getByRole("combobox", { name: "Parent" }).element().click();

		await expect.element(screen.getByRole("option", { name: "About" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Home", exact: true }).query()).toBeNull();
		expect(screen.getByRole("option", { name: "Services", exact: true }).query()).toBeNull();
	});

	it("renders nested items indented under their parent", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [
				...defaultMenu.items,
				{
					id: "3",
					menuId: "menu1",
					parentId: "1",
					sortOrder: 0,
					type: "custom",
					referenceCollection: null,
					referenceId: null,
					customUrl: "/services",
					label: "Services",
					titleAttr: null,
					target: "_self",
					cssClasses: null,
					createdAt: "",
					locale: "en",
					translationGroup: "3",
				},
			],
		});

		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Services", { exact: true })).toBeInTheDocument();
		const servicesRow = screen
			.getByText("Services", { exact: true })
			.element()
			.closest("div.border");
		expect((servicesRow as HTMLElement | null)?.style.marginInlineStart).toBe("1.5rem");
	});

	it("treats an item whose parent is missing as a top-level item", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [
				...defaultMenu.items,
				{
					id: "3",
					menuId: "menu1",
					parentId: "deleted-parent",
					sortOrder: 0,
					type: "custom",
					referenceCollection: null,
					referenceId: null,
					customUrl: "/services",
					label: "Services",
					titleAttr: null,
					target: "_self",
					cssClasses: null,
					createdAt: "",
					locale: "en",
					translationGroup: "3",
				},
			],
		});

		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Services", { exact: true })).toBeInTheDocument();
		const servicesRow = screen
			.getByText("Services", { exact: true })
			.element()
			.closest("div.border") as HTMLElement;
		expect(servicesRow.style.marginInlineStart).toBe("0rem");
		const upBtn = servicesRow.querySelector('button[aria-label="Move up"]') as HTMLButtonElement;
		expect(upBtn.disabled).toBe(false);
	});

	it("reorder buttons only compare against siblings, not the whole flat list", async () => {
		vi.mocked(api.fetchMenu).mockResolvedValue({
			...defaultMenu,
			items: [
				...defaultMenu.items,
				{
					id: "3",
					menuId: "menu1",
					parentId: "1",
					sortOrder: 0,
					type: "custom",
					referenceCollection: null,
					referenceId: null,
					customUrl: "/services",
					label: "Services",
					titleAttr: null,
					target: "_self",
					cssClasses: null,
					createdAt: "",
					locale: "en",
					translationGroup: "3",
				},
			],
		});

		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await expect.element(screen.getByText("Services", { exact: true })).toBeInTheDocument();
		// "Services" is Home's only child, so both its up and down buttons are
		// disabled even though it isn't the first/last item in the flat list.
		const servicesRow = screen
			.getByText("Services", { exact: true })
			.element()
			.closest("div.border") as HTMLElement;
		const upBtn = servicesRow.querySelector('button[aria-label="Move up"]') as HTMLButtonElement;
		const downBtn = servicesRow.querySelector(
			'button[aria-label="Move down"]',
		) as HTMLButtonElement;
		expect(upBtn.disabled).toBe(true);
		expect(downBtn.disabled).toBe(true);
	});
});
