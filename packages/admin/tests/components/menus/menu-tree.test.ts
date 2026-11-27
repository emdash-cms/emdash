import { describe, expect, it } from "vitest";

import {
	applyDrop,
	applyMove,
	availableMoves,
	deepestAllowedDepth,
	flattenMenu,
	getProjection,
	removeChildrenOf,
	toReorderInput,
} from "../../../src/components/menus/menu-tree";
import type { MenuItem } from "../../../src/lib/api";

function item(id: string, parentId: string | null = null): MenuItem {
	return {
		id,
		menuId: "menu",
		parentId,
		sortOrder: 0,
		type: "custom",
		referenceCollection: null,
		referenceId: null,
		customUrl: `/${id}`,
		label: id,
		titleAttr: null,
		target: null,
		cssClasses: null,
		createdAt: "",
		locale: "en",
		translationGroup: id,
	};
}

/** `[id, depth]` pairs in display order. */
function outline(items: MenuItem[]) {
	return flattenMenu(items).map((entry) => [entry.id, entry.depth]);
}

function places(items: MenuItem[]) {
	return toReorderInput(items).items;
}

describe("flattenMenu", () => {
	it("lists children right after their parent, in their order", () => {
		const items = [item("a"), item("b"), item("a2", "a"), item("a1", "a"), item("a2x", "a2")];

		expect(outline(items)).toEqual([
			["a", 0],
			["a2", 1],
			["a2x", 2],
			["a1", 1],
			["b", 0],
		]);
	});

	it("leaves out items in a parent cycle and items under a missing parent", () => {
		const items = [item("a"), item("x", "y"), item("y", "x"), item("orphan", "gone")];

		expect(outline(items)).toEqual([["a", 0]]);
	});
});

describe("toReorderInput", () => {
	it("numbers each item among its siblings in display order", () => {
		const items = [item("a"), item("a1", "a"), item("b"), item("a2", "a")];

		expect(places(items)).toEqual([
			{ id: "a", parentId: null, sortOrder: 0 },
			{ id: "a1", parentId: "a", sortOrder: 0 },
			{ id: "a2", parentId: "a", sortOrder: 1 },
			{ id: "b", parentId: null, sortOrder: 1 },
		]);
	});

	it("leaves cyclic items out of the request", () => {
		const items = [item("a"), item("x", "y"), item("y", "x")];

		expect(places(items).map((place) => place.id)).toEqual(["a"]);
	});
});

describe("applyDrop", () => {
	it("moves an item to another row's place under a new parent", () => {
		const items = [item("a"), item("a1", "a"), item("b"), item("c")];

		expect(places(applyDrop(items, "c", "a1", "a"))).toEqual([
			{ id: "a", parentId: null, sortOrder: 0 },
			{ id: "c", parentId: "a", sortOrder: 0 },
			{ id: "a1", parentId: "a", sortOrder: 1 },
			{ id: "b", parentId: null, sortOrder: 1 },
		]);
	});

	it("carries a dragged parent's children with it", () => {
		const items = [item("a"), item("a1", "a"), item("a1x", "a1"), item("b")];

		expect(outline(applyDrop(items, "a", "b", null))).toEqual([
			["b", 0],
			["a", 0],
			["a1", 1],
			["a1x", 2],
		]);
	});
});

describe("getProjection", () => {
	const items = [item("a"), item("b"), item("b1", "b"), item("c")];

	it("follows the sideways drag up to one level below the row above", () => {
		const flat = flattenMenu(items);

		expect(getProjection(flat, "c", "c", 1, 2)).toMatchObject({ depth: 1, parentId: "b" });
		expect(getProjection(flat, "c", "c", 2, 2)).toMatchObject({ depth: 2, parentId: "b1" });
		expect(getProjection(flat, "c", "c", 5, 2)).toMatchObject({ depth: 2, parentId: "b1" });
		expect(getProjection(flat, "a", "a", 3, 2)).toMatchObject({ depth: 0, parentId: null });
	});

	it("keeps the row at least as deep as the row it lands above", () => {
		const flat = flattenMenu(items);

		expect(getProjection(flat, "c", "b1", -4, 2)).toMatchObject({
			depth: 1,
			minDepth: 1,
			parentId: "b",
		});
	});

	it("stops at the third level, counting the dragged item's own children", () => {
		const nested = [...items, item("c1", "c")];
		const flat = flattenMenu(nested);
		const visible = removeChildrenOf(flat, ["c"]);

		expect(deepestAllowedDepth(flat, "c")).toBe(1);
		expect(getProjection(visible, "c", "c", 2, deepestAllowedDepth(flat, "c"))).toMatchObject({
			depth: 1,
			parentId: "b",
		});
	});

	it("keeps a parent whose subtree is three levels deep at the top level", () => {
		const deep = [item("a"), item("b"), item("b1", "b"), item("b1x", "b1")];
		const flat = flattenMenu(deep);
		const visible = removeChildrenOf(flat, ["b"]);

		expect(deepestAllowedDepth(flat, "b")).toBe(0);
		expect(getProjection(visible, "b", "b", 1, deepestAllowedDepth(flat, "b"))).toMatchObject({
			depth: 0,
			parentId: null,
		});
	});

	it("refuses a spot where the row below would have to nest deeper than allowed", () => {
		const tree = [
			item("h"),
			item("h1", "h"),
			item("h1a", "h1"),
			item("h1b", "h1"),
			item("p"),
			item("p1", "p"),
		];
		const flat = flattenMenu(tree);
		const visible = removeChildrenOf(flat, ["p"]);

		expect(getProjection(visible, "p", "h1b", 1, deepestAllowedDepth(flat, "p"))).toBeNull();
		expect(getProjection(visible, "p", "h1b", 1, 2)).toMatchObject({ depth: 2, parentId: "h1" });
	});

	it("lifts an item that sits deeper than three levels up to the third level", () => {
		const deep = [item("a"), item("a1", "a"), item("a1x", "a1"), item("a1xy", "a1x")];
		const flat = flattenMenu(deep);

		expect(outline(deep).at(-1)).toEqual(["a1xy", 3]);
		expect(getProjection(flat, "a1xy", "a1xy", 0, deepestAllowedDepth(flat, "a1xy"))).toMatchObject(
			{ depth: 2, parentId: "a1" },
		);
	});
});

describe("availableMoves and applyMove", () => {
	it("moves among siblings only", () => {
		const items = [item("a"), item("a1", "a"), item("b")];

		expect(availableMoves(items, "a1")).toEqual({
			up: false,
			down: false,
			indent: false,
			outdent: true,
		});
		expect(outline(applyMove(items, "b", "up")!)).toEqual([
			["b", 0],
			["a", 0],
			["a1", 1],
		]);
		expect(applyMove(items, "a1", "up")).toBeNull();
	});

	it("indents an item as the last child of the sibling above it", () => {
		const items = [item("a"), item("a1", "a"), item("b")];

		expect(places(applyMove(items, "b", "indent")!)).toEqual([
			{ id: "a", parentId: null, sortOrder: 0 },
			{ id: "a1", parentId: "a", sortOrder: 0 },
			{ id: "b", parentId: "a", sortOrder: 1 },
		]);
	});

	it("outdents an item to just after its parent", () => {
		const items = [item("a"), item("a1", "a"), item("a2", "a"), item("b")];

		expect(outline(applyMove(items, "a1", "outdent")!)).toEqual([
			["a", 0],
			["a2", 1],
			["a1", 0],
			["b", 0],
		]);
	});

	it("won't indent past the third level, counting the item's children", () => {
		const items = [item("a"), item("a1", "a"), item("a2", "a"), item("a2x", "a2")];

		expect(availableMoves(items, "a2").indent).toBe(false);
		expect(applyMove(items, "a2", "indent")).toBeNull();
		expect(availableMoves([...items, item("a3", "a")], "a3").indent).toBe(true);
	});
});
