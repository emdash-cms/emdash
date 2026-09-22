import { describe, expect, it } from "vitest";

import { groupNavItems, taxonomyGroup } from "../../src/lib/sidebar-groups";

describe("groupNavItems", () => {
	it("folds items sharing a group into one folder at the first member's position", () => {
		const entries = groupNavItems([
			{ id: "pages" },
			{ id: "events", group: "Calendar" },
			{ id: "team" },
			{ id: "series", group: "Calendar" },
		]);

		expect(entries.map((e) => (e.kind === "item" ? e.item.id : `[${e.label}]`))).toEqual([
			"pages",
			"[Calendar]",
			"team",
		]);
		const folder = entries[1];
		expect(folder?.kind === "folder" && folder.items.map((i) => i.id)).toEqual([
			"events",
			"series",
		]);
	});

	it("orders folder members by rank before input order", () => {
		const [folder] = groupNavItems([
			{ id: "sync", group: "Calendar", groupRank: 2 },
			{ id: "events", group: "Calendar", groupRank: 0 },
			{ id: "season", group: "Calendar", groupRank: 1 },
			{ id: "series", group: "Calendar", groupRank: 0 },
		]);

		expect(folder?.kind === "folder" && folder.items.map((i) => i.id)).toEqual([
			"events",
			"series",
			"season",
			"sync",
		]);
	});

	it("treats blank and padded group labels as the same folder or none", () => {
		const entries = groupNavItems([
			{ id: "a", group: "  Calendar " },
			{ id: "b", group: "Calendar" },
			{ id: "c", group: "   " },
		]);

		expect(entries).toHaveLength(2);
		expect(entries[0]?.kind === "folder" && entries[0].items.map((i) => i.id)).toEqual(["a", "b"]);
		expect(entries[1]?.kind).toBe("item");
	});
});

describe("taxonomyGroup", () => {
	const groups = new Map([
		["events", "Calendar"],
		["series", "Calendar"],
		["news", undefined],
		["team", "Club"],
	]);

	it("joins the folder when every assigned collection shares it", () => {
		expect(taxonomyGroup(["events", "series"], groups)).toBe("Calendar");
	});

	it("stays global when assignments span groups, ungrouped, or unknown collections", () => {
		expect(taxonomyGroup(["events", "team"], groups)).toBeUndefined();
		expect(taxonomyGroup(["events", "news"], groups)).toBeUndefined();
		expect(taxonomyGroup(["events", "missing"], groups)).toBeUndefined();
		expect(taxonomyGroup([], groups)).toBeUndefined();
	});
});
