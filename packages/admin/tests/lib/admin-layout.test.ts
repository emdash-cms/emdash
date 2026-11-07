import { describe, expect, it } from "vitest";

import {
	arrangeEditor,
	arrangeNav,
	EMPTY_ADMIN_LAYOUT,
	EMPTY_LIST_LAYOUT,
	moveEditorSection,
	moveNavEntry,
	navPathId,
	parseAdminLayout,
	resolveEditor,
	resolveNav,
	setHidden,
	toStoredAdminLayout,
	type AdminLayout,
	type LayoutNavGroup,
	type ListLayout,
} from "../../src/lib/admin-layout";
import { groupNavItems, type NavEntry } from "../../src/lib/sidebar-groups";

interface Link {
	id: string;
	group?: string;
	groupRank?: number;
}

const item = (id: string): NavEntry<Link> => ({ kind: "item", item: { id } });

const NAV: LayoutNavGroup<Link>[] = [
	{ key: "top", label: null, entries: [item("/"), item("/calendar")] },
	{
		key: "content",
		label: "Content",
		entries: groupNavItems<Link>([
			{ id: "/content/posts" },
			{ id: "/plugins/sync", group: "Calendar", groupRank: 2 },
			{ id: "/content/events", group: "Calendar", groupRank: 0 },
			{ id: "/content/pages" },
			{ id: "/media" },
		]),
	},
	{
		key: "manage",
		label: "Manage",
		entries: [item("/comments"), item("/menus"), item("/widgets")],
	},
];

/** Each group as `key: [ids]`, a folder as `folder:<label>[member ids]`. */
function shape(groups: readonly LayoutNavGroup<Link>[]) {
	return groups.map((group) => [
		group.key,
		group.entries.map((entry) =>
			entry.kind === "item"
				? entry.item.id
				: `folder:${entry.label}[${entry.items.map((link) => link.id).join(" ")}]`,
		),
	]);
}

const list = (order: string[] = [], hidden: string[] = []): ListLayout => ({ order, hidden });

const sections = (...ids: string[]) => ids.map((id) => ({ id }));

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

describe("parseAdminLayout", () => {
	const valid = { version: 1, nav: list(["/menus"], ["/widgets"]), editor: list(["seo"], []) };

	it("reads a valid layout", () => {
		expect(parseAdminLayout(valid)).toEqual(valid);
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["a string", JSON.stringify(valid)],
		["version 2", { ...valid, version: 2 }],
		["a non-array list", { ...valid, nav: { order: "/menus", hidden: [] } }],
		["a non-string ID", { ...valid, editor: { order: ["seo", 3], hidden: [] } }],
		["a missing list", { version: 1, nav: valid.nav }],
	])("treats %s as no layout", (_name, raw) => {
		expect(parseAdminLayout(raw)).toEqual(EMPTY_ADMIN_LAYOUT);
	});

	it("drops duplicate IDs, keeping the first", () => {
		const layout = parseAdminLayout({
			version: 1,
			nav: { order: ["/menus", "/comments", "/menus"], hidden: ["/widgets", "/widgets"] },
			editor: { order: ["seo", "publish", "seo"], hidden: [] },
		});
		expect(layout.nav).toEqual(list(["/menus", "/comments"], ["/widgets"]));
		expect(layout.editor.order).toEqual(["seo", "publish"]);
	});
});

describe("navPathId", () => {
	it.each([
		["/taxonomies/category?locale=fr", "/taxonomies/category"],
		["/plugins/forms/", "/plugins/forms"],
		["/plugins/forms/submissions", "/plugins/forms/submissions"],
		["/a#b", "/a"],
		["/", "/"],
	])("%s → %s", (path, id) => {
		expect(navPathId(path)).toBe(id);
	});
});

describe("arrangeEditor and resolveEditor", () => {
	it("defaults built-ins to their own order, with plugin panels between SEO and Outline in input order", () => {
		const input = sections(
			"revisions",
			"sandbox-plugin:zeta:panel",
			"outline",
			"seo",
			"publish",
			"plugin:alpha:panel",
			"url-language",
			"bylines",
		);
		expect(ids(resolveEditor(input, EMPTY_LIST_LAYOUT))).toEqual([
			"publish",
			"url-language",
			"bylines",
			"seo",
			"sandbox-plugin:zeta:panel",
			"plugin:alpha:panel",
			"outline",
			"revisions",
		]);
	});

	it("puts saved IDs first and new sections after them in default order", () => {
		const input = sections("publish", "url-language", "seo", "outline", "revisions");
		expect(ids(resolveEditor(input, list(["outline", "publish", "seo"])))).toEqual([
			"outline",
			"publish",
			"seo",
			"url-language",
			"revisions",
		]);
	});

	it("ignores unknown IDs and later duplicates in the saved order", () => {
		const input = sections("publish", "url-language", "seo");
		expect(ids(resolveEditor(input, list(["seo", "plugin:gone:panel", "publish", "seo"])))).toEqual(
			["seo", "publish", "url-language"],
		);
	});

	it("drops hidden sections but always renders Publish", () => {
		const input = sections("publish", "url-language", "seo");
		const layout = list([], ["publish", "seo"]);
		expect(ids(resolveEditor(input, layout))).toEqual(["publish", "url-language"]);
		expect(arrangeEditor(input, layout)).toEqual([
			expect.objectContaining({ id: "publish", hidden: false, canHide: false, canMove: true }),
			expect.objectContaining({ id: "url-language", hidden: false, canHide: true }),
			expect.objectContaining({ id: "seo", hidden: true, canHide: true }),
		]);
	});
});

describe("arrangeNav and resolveNav", () => {
	it("keeps the builder's order, groupRank included, when nothing is saved", () => {
		expect(shape(resolveNav(NAV, EMPTY_LIST_LAYOUT))).toEqual([
			["top", ["/", "/calendar"]],
			[
				"content",
				[
					"/content/posts",
					"folder:Calendar[/content/events /plugins/sync]",
					"/content/pages",
					"/media",
				],
			],
			["manage", ["/comments", "/menus", "/widgets"]],
		]);
	});

	it("applies one flat order within each group and within each folder", () => {
		const layout = list([
			"/widgets",
			"/content/pages",
			"/plugins/sync",
			"folder:Calendar",
			"/comments",
		]);
		expect(shape(resolveNav(NAV, layout))).toEqual([
			["top", ["/", "/calendar"]],
			[
				"content",
				[
					"/content/pages",
					"folder:Calendar[/plugins/sync /content/events]",
					"/content/posts",
					"/media",
				],
			],
			["manage", ["/widgets", "/comments", "/menus"]],
		]);
	});

	it("keeps Dashboard first and shown whatever the layout says", () => {
		const layout = list(["/calendar", "/"], ["/"]);
		expect(shape(resolveNav(NAV, layout))[0]).toEqual(["top", ["/", "/calendar"]]);
		expect(arrangeNav(NAV, layout)[0]?.entries[0]).toMatchObject({
			id: "/",
			hidden: false,
			canMove: false,
			canHide: false,
		});
	});

	it("hides a folder only when every member is hidden, and ignores a folder ID in hidden", () => {
		expect(shape(resolveNav(NAV, list([], ["folder:Calendar"])))[1]).toEqual([
			"content",
			[
				"/content/posts",
				"folder:Calendar[/content/events /plugins/sync]",
				"/content/pages",
				"/media",
			],
		]);
		expect(shape(resolveNav(NAV, list([], ["/plugins/sync"])))[1]?.[1]).toContain(
			"folder:Calendar[/content/events]",
		);

		const allHidden = list([], ["/content/events", "/plugins/sync"]);
		expect(shape(resolveNav(NAV, allHidden))[1]).toEqual([
			"content",
			["/content/posts", "/content/pages", "/media"],
		]);
		expect(arrangeNav(NAV, allHidden)[1]?.entries[1]).toMatchObject({
			kind: "folder",
			id: "folder:Calendar",
			hidden: true,
			canHide: false,
			canMove: true,
		});
	});

	it("drops a group whose entries are all hidden, but still lists it for Settings", () => {
		const layout = list([], ["/comments", "/menus", "/widgets"]);
		expect(resolveNav(NAV, layout).map((group) => group.key)).toEqual(["top", "content"]);
		expect(arrangeNav(NAV, layout)[2]).toMatchObject({ key: "manage", hidden: true });
	});
});

describe("setHidden", () => {
	it("adds one ID and leaves order and unmatched IDs alone", () => {
		const before = list(["/menus"], ["/plugins/gone"]);
		const after = setHidden("nav", before, "/widgets", true);
		expect(after.hidden).toEqual(["/plugins/gone", "/widgets"]);
		expect(after.order).toBe(before.order);
	});

	it("removes one ID and keeps unmatched IDs", () => {
		const before = list([], ["/plugins/gone", "/widgets"]);
		expect(setHidden("nav", before, "/widgets", false).hidden).toEqual(["/plugins/gone"]);
	});

	it("returns the same object when nothing changes", () => {
		const before = list([], ["/widgets"]);
		expect(setHidden("nav", before, "/widgets", true)).toBe(before);
		expect(setHidden("nav", before, "/menus", false)).toBe(before);
	});

	it("refuses Dashboard, folders, and Publish", () => {
		const before = list();
		expect(setHidden("nav", before, "/", true)).toBe(before);
		expect(setHidden("nav", before, "folder:Calendar", true)).toBe(before);
		expect(setHidden("editor", before, "publish", true)).toBe(before);
	});
});

describe("moveNavEntry", () => {
	it("writes every movable entry the list shows, hidden ones included, and leaves hidden alone", () => {
		const before = list(["/plugins/gone"], ["/menus"]);
		const after = moveNavEntry(NAV, before, "/comments", "/widgets");

		expect(after.hidden).toBe(before.hidden);
		expect([...after.order].toSorted()).toEqual(
			[
				"/calendar",
				"/content/posts",
				"folder:Calendar",
				"/content/events",
				"/plugins/sync",
				"/content/pages",
				"/media",
				"/comments",
				"/menus",
				"/widgets",
			].toSorted(),
		);
		expect(shape(resolveNav(NAV, after))[2]).toEqual(["manage", ["/widgets", "/comments"]]);
		expect(shape(resolveNav(NAV, setHidden("nav", after, "/menus", false)))[2]).toEqual([
			"manage",
			["/menus", "/widgets", "/comments"],
		]);
	});

	it("moves a member within its folder", () => {
		const after = moveNavEntry(NAV, EMPTY_LIST_LAYOUT, "/plugins/sync", "/content/events");
		expect(shape(resolveNav(NAV, after))[1]?.[1]).toContain(
			"folder:Calendar[/plugins/sync /content/events]",
		);
	});

	it.each([
		["across groups", "/widgets", "/content/posts"],
		["out of a folder", "/content/events", "/content/posts"],
		["onto itself", "/widgets", "/widgets"],
		["of Dashboard", "/", "/calendar"],
		["onto Dashboard", "/calendar", "/"],
		["of an unknown entry", "/plugins/gone", "/widgets"],
	])("returns the same object for a move %s", (_name, activeId, overId) => {
		const before = list(["/menus"]);
		expect(moveNavEntry(NAV, before, activeId, overId)).toBe(before);
	});

	it("keeps both of two moves composed from the latest layout", () => {
		const first = moveNavEntry(NAV, EMPTY_LIST_LAYOUT, "/widgets", "/comments");
		const second = moveNavEntry(NAV, first, "/content/pages", "/content/posts");
		const resolved = shape(resolveNav(NAV, second));
		expect(resolved[1]?.[1]?.slice(0, 2)).toEqual(["/content/pages", "/content/posts"]);
		expect(resolved[2]).toEqual(["manage", ["/widgets", "/comments", "/menus"]]);
	});
});

describe("moveEditorSection", () => {
	const input = sections("publish", "url-language", "seo", "outline");

	it("writes every section the list shows, hidden ones included, and leaves hidden alone", () => {
		const before = list(["plugin:gone:panel"], ["url-language"]);
		const after = moveEditorSection(input, before, "outline", "seo");

		expect(after.hidden).toBe(before.hidden);
		expect([...after.order].toSorted()).toEqual(
			["outline", "publish", "seo", "url-language"].toSorted(),
		);
		expect(ids(resolveEditor(input, after))).toEqual(["publish", "outline", "seo"]);
		expect(ids(resolveEditor(input, setHidden("editor", after, "url-language", false)))).toEqual([
			"publish",
			"url-language",
			"outline",
			"seo",
		]);
	});

	it("returns the same object for a move onto itself or of an unknown section", () => {
		const before = list(["seo"]);
		expect(moveEditorSection(input, before, "seo", "seo")).toBe(before);
		expect(moveEditorSection(input, before, "plugin:gone:panel", "seo")).toBe(before);
	});

	it("keeps both of two moves composed from the latest layout", () => {
		const first = moveEditorSection(input, EMPTY_LIST_LAYOUT, "outline", "publish");
		const second = moveEditorSection(input, first, "seo", "url-language");
		expect(ids(resolveEditor(input, second))).toEqual([
			"outline",
			"publish",
			"seo",
			"url-language",
		]);
	});
});

describe("toStoredAdminLayout", () => {
	it("sends null when both lists are empty, so the stored key is removed", () => {
		expect(toStoredAdminLayout(EMPTY_ADMIN_LAYOUT)).toBeNull();
		expect(toStoredAdminLayout({ version: 1, nav: list(), editor: list() })).toBeNull();
	});

	it("sends the layout when either list stores something", () => {
		const hiddenOnly: AdminLayout = { version: 1, nav: list(), editor: list([], ["seo"]) };
		expect(toStoredAdminLayout(hiddenOnly)).toBe(hiddenOnly);
		const orderOnly: AdminLayout = { version: 1, nav: list(["/menus"]), editor: list() };
		expect(toStoredAdminLayout(orderOnly)).toBe(orderOnly);
	});
});
