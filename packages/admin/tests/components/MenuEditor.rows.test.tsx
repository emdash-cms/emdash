import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider, type QueryClientConfig } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { MenuEditor } from "../../src/components/MenuEditor";
import type { AdminManifest, ContentItem, MenuItem, MenuWithItems } from "../../src/lib/api";
import { ApiResponseError } from "../../src/lib/api/client.js";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
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
		fetchManifest: vi.fn(),
		fetchContent: vi.fn(),
		fetchContentList: vi.fn(),
		fetchTrashedContent: vi.fn(),
		fetchTaxonomyDefs: vi.fn(),
		fetchTerms: vi.fn(),
		createMenuItem: vi.fn(),
		updateMenuItem: vi.fn().mockResolvedValue({}),
		deleteMenuItem: vi.fn().mockResolvedValue(undefined),
		reorderMenuItems: vi.fn().mockResolvedValue([]),
	};
});

import * as api from "../../src/lib/api";

function collection(label: string, extra: Partial<AdminManifest["collections"][string]> = {}) {
	return { label, labelSingular: label, supports: [], hasSeo: false, fields: {}, ...extra };
}

const manifest = {
	version: "1",
	hash: "test",
	collections: {
		pages: collection("Pages", { urlPattern: "/{slug}" }),
		posts: collection("Posts", { urlPattern: "/blog/{slug}" }),
		docs: collection("Docs"),
		secret: collection("Secret", { hidden: true }),
	},
} as unknown as AdminManifest;

function entry(id: string, slug: string, title: string, status = "published"): ContentItem {
	return {
		id,
		type: "posts",
		slug,
		status,
		locale: "en",
		translationGroup: id,
		data: { title },
		authorId: null,
		primaryBylineId: null,
		createdAt: "",
		updatedAt: "",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	} as ContentItem;
}

const entries: Record<string, ContentItem> = {
	pricing: entry("pricing", "pricing", "Pricing"),
	wip: entry("wip", "work-in-progress", "Work in progress", "draft"),
	soon: entry("soon", "coming-soon", "Coming soon", "scheduled"),
	guide: entry("guide", "setup", "Setup guide"),
};

function menuItem(id: string, label: string, fields: Partial<MenuItem>): MenuItem {
	return {
		id,
		menuId: "menu1",
		parentId: null,
		sortOrder: 0,
		type: "custom",
		referenceCollection: null,
		referenceId: null,
		customUrl: null,
		label,
		titleAttr: null,
		target: null,
		cssClasses: null,
		createdAt: "",
		locale: "en",
		translationGroup: id,
		...fields,
	};
}

const rows = [
	menuItem("1", "Pricing", { type: "page", referenceCollection: "pages", referenceId: "pricing" }),
	menuItem("2", "Blog", { type: "collection", referenceCollection: "posts" }),
	menuItem("3", "Development", {
		type: "taxonomy",
		referenceCollection: "category",
		referenceId: "dev",
	}),
	menuItem("4", "Resources", { customUrl: "#" }),
	menuItem("5", "WIP", { type: "post", referenceCollection: "posts", referenceId: "wip" }),
	menuItem("6", "Docs", { customUrl: "https://docs.example.com", target: "_blank" }),
	menuItem("7", "Old post", { type: "post", referenceCollection: "posts", referenceId: "trashed" }),
	menuItem("8", "Gone", { type: "post", referenceCollection: "posts", referenceId: "gone" }),
	menuItem("9", "Setup", { type: "collection", referenceCollection: "docs", referenceId: "guide" }),
	menuItem("10", "Soon", { type: "post", referenceCollection: "posts", referenceId: "soon" }),
	menuItem("11", "Flaky", { type: "post", referenceCollection: "posts", referenceId: "flaky" }),
	menuItem("12", "Old tag", {
		type: "taxonomy",
		referenceCollection: "category",
		referenceId: "x",
	}),
];

const menu: MenuWithItems = {
	id: "menu1",
	name: "main-menu",
	label: "Main Menu",
	createdAt: "",
	updatedAt: "",
	locale: "en",
	translationGroup: "menu1",
	items: rows.map((item, index) => ({ ...item, sortOrder: index })),
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

function row(id: string) {
	return document.querySelector<HTMLElement>(`[data-menu-item-id="${id}"]`)!;
}

function visibleText(element: HTMLElement) {
	return element.innerText.replace(/\s+/g, " ").trim();
}

type Screen = Awaited<ReturnType<typeof render>>;

async function chooseSource(screen: Screen, dialog: ReturnType<Screen["getByRole"]>, name: string) {
	dialog.getByRole("combobox", { name: "Source" }).element().click();
	await screen.getByRole("option", { name, exact: true }).click();
}

describe("MenuEditor rows", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		vi.mocked(api.fetchMenu).mockResolvedValue(menu);
		vi.mocked(api.fetchManifest).mockResolvedValue(manifest);
		vi.mocked(api.fetchContent).mockImplementation(async (_collection, id) => {
			const found = entries[id];
			if (found) return found;
			if (id === "flaky") throw new ApiResponseError(500, "INTERNAL_ERROR", "Server error");
			throw new ApiResponseError(404, "NOT_FOUND", "Content not found");
		});
		vi.mocked(api.fetchTrashedContent).mockResolvedValue({
			items: [entry("trashed", "old-post", "Old post", "draft")],
		});
		vi.mocked(api.fetchTaxonomyDefs).mockResolvedValue([
			{
				id: "tax1",
				name: "category",
				label: "Categories",
				hierarchical: true,
				collections: ["posts"],
				locale: "en",
				translationGroup: "tax1",
			},
		]);
		vi.mocked(api.fetchTerms).mockResolvedValue([
			{
				id: "dev",
				name: "category",
				slug: "development",
				label: "Development",
				children: [],
				locale: "en",
				translationGroup: "dev",
			},
		]);
		vi.mocked(api.fetchContentList).mockResolvedValue({ items: [entries.pricing!] });
		vi.mocked(api.createMenuItem).mockResolvedValue(rows[0]!);
	});

	afterEach(() => {
		document.documentElement.dir = "ltr";
	});

	it("shows where each kind of item goes, and flags the ones the site hides", async () => {
		await render(<MenuEditor />, { wrapper: Wrapper });

		const expected: Record<string, string> = {
			"1": "Pricing /pricing",
			"2": "Blog All Posts",
			"3": "Development Categories · Development",
			"4": "Resources Heading",
			"5": "WIP /blog/work-in-progress Draft · hidden on the site",
			"6": "Docs https://docs.example.com",
			"7": "Old post In trash · hidden on the site",
			"8": "Gone Not found · hidden on the site",
			"9": "Setup Setup guide",
			"10": "Soon /blog/coming-soon Draft · hidden on the site",
			"11": "Flaky",
			"12": "Old tag Not found · hidden on the site",
		};
		for (const [id, text] of Object.entries(expected)) {
			await vi.waitFor(() => expect(visibleText(row(id))).toBe(text));
		}
		expect(row("6").querySelector('[aria-label="Opens in a new tab"]')).not.toBeNull();
		expect(row("1").querySelector('[aria-label="Opens in a new tab"]')).toBeNull();
	});

	it("shortens the badges when the list is narrow", async () => {
		const screen = await render(
			<div style={{ width: 400 }}>
				<MenuEditor />
			</div>,
			{ wrapper: Wrapper },
		);

		await expect.element(screen.getByText("Draft", { exact: true }).first()).toBeVisible();
		await expect.element(screen.getByText("In trash", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("In trash · hidden on the site")).not.toBeVisible();
	});

	it("shows what an entry links to in Edit, without a URL field", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "WIP", exact: true }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit menu item" });
		await expect.element(dialog.getByText("Links to")).toBeVisible();
		await expect.element(dialog.getByText("Work in progress")).toBeVisible();
		await expect.element(dialog.getByText("/blog/work-in-progress")).toBeVisible();
		await expect.element(dialog.getByText("Draft", { exact: true })).toBeVisible();
		expect(dialog.getByRole("textbox", { name: "URL" }).query()).toBeNull();
		await expect.element(dialog.getByRole("switch", { name: "Open in new tab" })).toBeVisible();
	});

	it("offers no new-tab switch on a heading", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Resources", exact: true }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit menu item" });
		await expect.element(dialog.getByRole("textbox", { name: "URL" })).toHaveValue("");
		expect(dialog.getByRole("switch", { name: "Open in new tab" }).query()).toBeNull();
	});

	it("clears a link's target when Open in new tab is turned off", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Docs", exact: true }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit menu item" });
		const newTab = dialog.getByRole("switch", { name: "Open in new tab" });
		await expect.element(newTab).toBeChecked();
		await newTab.click();
		await dialog.getByRole("button", { name: "Save" }).click();

		await vi.waitFor(() =>
			expect(api.updateMenuItem).toHaveBeenCalledWith(
				"main-menu",
				"6",
				expect.objectContaining({ target: "" }),
				{ locale: "en" },
			),
		);
	});

	it("lists visible collections, taxonomies, archives, links and headings as sources", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Add items" }).click();
		const dialog = screen.getByRole("dialog", { name: "Add items" });
		dialog.getByRole("combobox", { name: "Source" }).element().click();
		const options = screen.getByRole("option");
		await expect.element(options.first()).toBeVisible();
		expect(options.elements().map((option) => option.textContent)).toEqual([
			"Pages",
			"Posts",
			"Docs",
			"Categories",
			"Archive pages",
			"Custom link",
			"Heading",
		]);
	});

	it("adds picks from several sources under the chosen parent, in the order picked", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Add items" }).click();
		const dialog = screen.getByRole("dialog", { name: "Add items" });
		await chooseSource(screen, dialog, "Pages");
		await dialog.getByRole("checkbox", { name: "Pricing" }).click();
		await chooseSource(screen, dialog, "Categories");
		await dialog.getByRole("checkbox", { name: "Development" }).click();
		await chooseSource(screen, dialog, "Archive pages");
		await dialog.getByRole("checkbox", { name: "All Posts" }).click();
		await chooseSource(screen, dialog, "Pages");
		await expect.element(dialog.getByRole("checkbox", { name: "Pricing" })).toBeChecked();
		dialog.getByRole("combobox", { name: "Add to" }).element().click();
		await screen.getByRole("option", { name: "Resources" }).click();
		await dialog.getByRole("button", { name: "Add 3 items" }).click();

		await expect.element(screen.getByText("Added 3 items")).toBeVisible();
		expect(vi.mocked(api.createMenuItem).mock.calls.map((call) => call[1])).toEqual([
			{
				type: "page",
				label: "Pricing",
				referenceCollection: "pages",
				referenceId: "pricing",
				parentId: "4",
			},
			{
				type: "taxonomy",
				label: "Development",
				referenceCollection: "category",
				referenceId: "dev",
				parentId: "4",
			},
			{ type: "collection", label: "Posts", referenceCollection: "posts", parentId: "4" },
		]);
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("keeps only the picks that weren't added when one fails", async () => {
		vi.mocked(api.createMenuItem)
			.mockResolvedValueOnce(rows[0]!)
			.mockRejectedValueOnce(new Error("Development could not be added"));
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: "Add items" }).click();
		const dialog = screen.getByRole("dialog", { name: "Add items" });
		await chooseSource(screen, dialog, "Pages");
		await dialog.getByRole("checkbox", { name: "Pricing" }).click();
		await chooseSource(screen, dialog, "Categories");
		await dialog.getByRole("checkbox", { name: "Development" }).click();
		await dialog.getByRole("button", { name: "Add 2 items" }).click();

		await expect
			.element(dialog.getByRole("alert"))
			.toHaveTextContent("Development could not be added");
		await expect.element(dialog.getByText("1 selected")).toBeVisible();
		await expect.element(dialog.getByRole("checkbox", { name: "Development" })).toBeChecked();
		await chooseSource(screen, dialog, "Pages");
		await expect.element(dialog.getByRole("checkbox", { name: "Pricing" })).not.toBeChecked();
		expect(api.createMenuItem).toHaveBeenCalledTimes(2);
	});
});

describe("MenuEditor keyboard moves", () => {
	const items = [
		menuItem("1", "Home", { customUrl: "/" }),
		menuItem("2", "About", { customUrl: "/about", sortOrder: 1 }),
	];

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.fetchMenu).mockResolvedValue({ ...menu, items });
		vi.mocked(api.fetchManifest).mockResolvedValue(manifest);
		vi.mocked(api.fetchTaxonomyDefs).mockResolvedValue([]);
	});

	afterEach(() => {
		document.documentElement.dir = "ltr";
	});

	it.each([
		["left to right", "ltr", "{ArrowRight}"],
		["right to left", "rtl", "{ArrowLeft}"],
	])("nests a row with the inline arrow key in %s", async (_name, dir, deeper) => {
		document.documentElement.dir = dir;
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const handle = screen.getByRole("button", { name: "Move About" });
		await expect.element(handle).toBeInTheDocument();
		handle.element().focus();
		await userEvent.keyboard(" ");
		await userEvent.keyboard(deeper);
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("About is inside Home, position 1 of 1."),
		);
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
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("Dropped About inside Home, position 1 of 1."),
		);
	});

	it("doesn't nest with the other inline arrow key in right to left", async () => {
		document.documentElement.dir = "rtl";
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const handle = screen.getByRole("button", { name: "Move About" });
		await expect.element(handle).toBeInTheDocument();
		handle.element().focus();
		await userEvent.keyboard(" ");
		await userEvent.keyboard("{ArrowRight}");
		await userEvent.keyboard(" ");

		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("Dropped About at the top level"),
		);
		expect(api.reorderMenuItems).not.toHaveBeenCalled();
	});
});

describe("MenuEditor saved order", () => {
	const home = menuItem("1", "Home", { customUrl: "/" });
	const about = menuItem("2", "About", { customUrl: "/about", sortOrder: 1 });
	const contact = menuItem("3", "Contact", { customUrl: "/contact", sortOrder: 2 });
	let saved: MenuItem[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		saved = [home, about, contact];
		vi.mocked(api.fetchMenu).mockImplementation(async () => ({ ...menu, items: saved }));
		vi.mocked(api.reorderMenuItems).mockImplementation(async (_name, input) => {
			const byId = new Map(saved.map((item) => [item.id, item]));
			saved = input.items.flatMap(({ id, parentId, sortOrder }) => {
				const stored = byId.get(id);
				return stored ? [{ ...stored, parentId, sortOrder }] : [];
			});
			return saved;
		});
		vi.mocked(api.deleteMenuItem).mockImplementation(async (_name, id) => {
			saved = saved.filter((item) => item.id !== id);
		});
		vi.mocked(api.fetchManifest).mockResolvedValue(manifest);
		vi.mocked(api.fetchTaxonomyDefs).mockResolvedValue([]);
	});

	function rowIds() {
		return Array.from(document.querySelectorAll("[data-menu-item-id]"), (element) =>
			element.getAttribute("data-menu-item-id"),
		);
	}

	async function chooseFromRowMenu(screen: Screen, label: string, action: string) {
		await screen.getByRole("button", { name: `Actions for ${label}` }).click();
		await screen
			.getByRole("menu", { name: `Actions for ${label}` })
			.getByRole("menuitem", { name: action })
			.click();
		await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
	}

	it("announces each move from the row menu with the row's new place", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		await chooseFromRowMenu(screen, "Contact", "Move up");
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("Contact is at the top level, position 2 of 3."),
		);
		await chooseFromRowMenu(screen, "Contact", "Move up");
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("Contact is at the top level, position 1 of 3."),
		);
		await vi.waitFor(() => expect(rowIds()).toEqual(["3", "1", "2"]));
		expect(api.reorderMenuItems).toHaveBeenCalledTimes(2);
	});

	it("drops a deleted row when a move cancels the delete's reload", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });
		await expect
			.element(screen.getByRole("button", { name: "Contact", exact: true }))
			.toBeVisible();
		const slowReload = Promise.withResolvers<MenuWithItems>();
		vi.mocked(api.fetchMenu).mockReturnValueOnce(slowReload.promise);

		await chooseFromRowMenu(screen, "Contact", "Delete");
		const confirm = screen.getByRole("dialog", { name: "Delete menu item?" });
		await confirm.getByRole("button", { name: "Delete" }).click();
		await expect.element(confirm).not.toBeInTheDocument();
		await vi.waitFor(() => expect(api.fetchMenu).toHaveBeenCalledTimes(2));
		await chooseFromRowMenu(screen, "Home", "Move down");

		await vi.waitFor(() => expect(rowIds()).toEqual(["2", "1"]));
	});

	it("moves a row down and nests it with the arrow keys", async () => {
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const handle = screen.getByRole("button", { name: "Move Home" });
		await expect.element(handle).toBeInTheDocument();
		handle.element().focus();
		await userEvent.keyboard(" ");
		await userEvent.keyboard("{ArrowDown}");
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("Home is at the top level, position 2 of 3."),
		);
		await userEvent.keyboard("{ArrowRight}");
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("Home is inside About, position 1 of 1."),
		);
		await userEvent.keyboard(" ");

		await vi.waitFor(() =>
			expect(api.reorderMenuItems).toHaveBeenCalledWith(
				"main-menu",
				{
					items: [
						{ id: "2", parentId: null, sortOrder: 0 },
						{ id: "1", parentId: "2", sortOrder: 0 },
						{ id: "3", parentId: null, sortOrder: 1 },
					],
				},
				{ locale: "en" },
			),
		);
	});

	it("skips spots a lifted parent can't land in when moving it with the arrow keys", async () => {
		saved = [
			menuItem("h", "Guides", { customUrl: "/guides" }),
			menuItem("h1", "Setup", { customUrl: "/setup", parentId: "h" }),
			menuItem("h1a", "Install", { customUrl: "/install", parentId: "h1" }),
			menuItem("h1b", "Deploy", { customUrl: "/deploy", parentId: "h1", sortOrder: 1 }),
			menuItem("p", "Projects", { customUrl: "/projects", sortOrder: 1 }),
			menuItem("p1", "Archive", { customUrl: "/archive", parentId: "p" }),
		];
		const screen = await render(<MenuEditor />, { wrapper: Wrapper });

		const handle = screen.getByRole("button", { name: "Move Projects" });
		await expect.element(handle).toBeInTheDocument();
		handle.element().focus();
		await userEvent.keyboard(" ");
		await userEvent.keyboard("{ArrowUp}");
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("Projects is inside Guides, position 1 of 2."),
		);
		await userEvent.keyboard(" ");

		await vi.waitFor(() =>
			expect(vi.mocked(api.reorderMenuItems).mock.calls[0]?.[1].items).toEqual([
				{ id: "h", parentId: null, sortOrder: 0 },
				{ id: "p", parentId: "h", sortOrder: 0 },
				{ id: "p1", parentId: "p", sortOrder: 0 },
				{ id: "h1", parentId: "h", sortOrder: 1 },
				{ id: "h1a", parentId: "h1", sortOrder: 0 },
				{ id: "h1b", parentId: "h1", sortOrder: 1 },
			]),
		);
	});

	it("reloads a menu that another screen already loaded when the editor opens", async () => {
		const config: QueryClientConfig = {
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		};
		const qc = new QueryClient(config);
		qc.setQueryData<MenuWithItems>(["menu", "main-menu", null], {
			...menu,
			items: [menuItem("old", "Old item", { customUrl: "/old" })],
		});
		const screen = await render(<MenuEditor />, {
			wrapper: ({ children }) => (
				<Toasty>
					<QueryClientProvider client={qc}>{children}</QueryClientProvider>
				</Toasty>
			),
		});

		await expect
			.element(screen.getByRole("button", { name: "Contact", exact: true }))
			.toBeVisible();
		expect(screen.getByText("Old item").query()).toBeNull();
	});
});
