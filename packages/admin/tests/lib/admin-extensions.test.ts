/**
 * Admin extension selection — the registration contract.
 *
 * These pin the pure semantics both host surfaces (content list, editor
 * sidebar) rely on: deterministic ordering independent of registration
 * order, first-wins duplicate handling (never silent overwrite), collection
 * and role filtering, fault isolation for throwing predicates, and the
 * zero-extension no-op guarantee. No DOM — rendering is covered in
 * tests/components/AdminContentExtensions.test.tsx.
 */

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	selectContentEditorPanels,
	selectContentListColumns,
	type AdminExtensionSource,
	type ContentEditorPanelExtension,
	type ContentListColumnExtension,
} from "../../src/lib/admin-extensions";

const ROLE_EDITOR = 40;
const ROLE_ADMIN = 50;

const Noop: React.ComponentType<never> = () => null;

function column(overrides: Partial<ContentListColumnExtension> & { id: string }) {
	return { label: overrides.id, cell: Noop, ...overrides } as ContentListColumnExtension;
}

function panel(overrides: Partial<ContentEditorPanelExtension> & { id: string }) {
	return { title: overrides.id, panel: Noop, ...overrides } as ContentEditorPanelExtension;
}

function source(modules: AdminExtensionSource): AdminExtensionSource {
	return modules;
}

const posts = { collection: "posts", userRole: ROLE_ADMIN };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("selectContentListColumns ordering", () => {
	it("orders by (order, id) regardless of plugin registration order", () => {
		const registry = source({
			// Intentionally registered in non-alphabetical plugin order.
			zeta: { contentListColumns: [column({ id: "zeta:one", order: 1 })] },
			alpha: {
				contentListColumns: [
					column({ id: "alpha:last", order: 10 }),
					column({ id: "alpha:first", order: -5 }),
				],
			},
			midway: { contentListColumns: [column({ id: "midway:tie", order: 1 })] },
		});

		expect(selectContentListColumns(registry, posts).map((c) => c.id)).toEqual([
			"alpha:first",
			"midway:tie", // order 1 tie broken by id: "midway:tie" < "zeta:one"
			"zeta:one",
			"alpha:last",
		]);
	});

	it("defaults order to 0 and breaks ties by id", () => {
		const registry = source({
			p: { contentListColumns: [column({ id: "p:b" }), column({ id: "p:a" })] },
		});
		expect(selectContentListColumns(registry, posts).map((c) => c.id)).toEqual(["p:a", "p:b"]);
	});
});

describe("collection applicability", () => {
	it("filters by collection list and predicate, keeping unrestricted columns", () => {
		const registry = source({
			p: {
				contentListColumns: [
					column({ id: "p:everywhere" }),
					column({ id: "p:posts-only", collections: ["posts"] }),
					column({ id: "p:pages-only", collections: ["pages"] }),
					column({ id: "p:predicate", collections: (slug) => slug.startsWith("po") }),
				],
			},
		});

		expect(selectContentListColumns(registry, posts).map((c) => c.id)).toEqual([
			"p:everywhere",
			"p:posts-only",
			"p:predicate",
		]);
		expect(
			selectContentListColumns(registry, { ...posts, collection: "pages" }).map((c) => c.id),
		).toEqual(["p:everywhere", "p:pages-only"]);
	});

	it("treats a throwing predicate as not applicable without dropping others", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const registry = source({
			p: {
				contentListColumns: [
					column({
						id: "p:broken",
						collections: () => {
							throw new Error("boom");
						},
					}),
					column({ id: "p:fine" }),
				],
			},
		});

		expect(selectContentListColumns(registry, posts).map((c) => c.id)).toEqual(["p:fine"]);
		expect(consoleError).toHaveBeenCalledOnce();
	});
});

describe("permission (minRole) filtering", () => {
	it("hides gated contributions below the required role", () => {
		const registry = source({
			p: {
				contentEditorPanels: [
					panel({ id: "p:any" }),
					panel({ id: "p:editor", minRole: ROLE_EDITOR }),
					panel({ id: "p:admin", minRole: ROLE_ADMIN }),
				],
			},
		});

		const ids = (role: number) =>
			selectContentEditorPanels(registry, { collection: "posts", userRole: role }).map((p) => p.id);

		expect(ids(0)).toEqual(["p:any"]);
		expect(ids(ROLE_EDITOR)).toEqual(["p:any", "p:editor"]);
		expect(ids(ROLE_ADMIN)).toEqual(["p:admin", "p:any", "p:editor"]);
	});
});

describe("duplicate ids", () => {
	it("keeps the first occurrence in sorted plugin order and warns — never silently overwrites", () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const winner = vi.fn(() => null);
		const loser = vi.fn(() => null);
		const registry = source({
			// "abc" sorts before "xyz", so abc's contribution must win even
			// though "xyz" appears first in the object literal.
			xyz: { contentListColumns: [column({ id: "shared:score", cell: loser })] },
			abc: { contentListColumns: [column({ id: "shared:score", cell: winner })] },
		});

		const selected = selectContentListColumns(registry, posts);
		expect(selected).toHaveLength(1);
		expect(selected[0]?.cell).toBe(winner);
		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining('Duplicate extension id "shared:score" from plugin "xyz"'),
		);
	});

	it("deduplicates per slot: a column and a panel may share an id", () => {
		const registry = source({
			p: {
				contentListColumns: [column({ id: "p:thing" })],
				contentEditorPanels: [panel({ id: "p:thing" })],
			},
		});
		expect(selectContentListColumns(registry, posts)).toHaveLength(1);
		expect(selectContentEditorPanels(registry, posts)).toHaveLength(1);
	});
});

describe("zero extensions and malformed contributions", () => {
	it("returns an empty list for an empty registry and for modules without contributions", () => {
		expect(selectContentListColumns({}, posts)).toEqual([]);
		expect(selectContentEditorPanels(source({ p: {} }), posts)).toEqual([]);
	});

	it("skips malformed entries with a warning instead of failing the slot", () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Deliberately malformed runtime data, as an untyped plugin build could produce.
		const registry = source({
			p: {
				contentListColumns: [
					{ label: "No id", cell: Noop } as ContentListColumnExtension,
					{
						id: "p:not-a-component",
						label: "x",
						cell: "nope",
					} as unknown as ContentListColumnExtension,
					column({ id: "p:valid" }),
				],
			},
		});

		expect(selectContentListColumns(registry, posts).map((c) => c.id)).toEqual(["p:valid"]);
		expect(consoleWarn).toHaveBeenCalledTimes(2);
	});

	it("ignores a non-array contributions export instead of crashing the host screen", () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// An untyped build can export the wrong container shape entirely.
		const registry = source({
			broken: {
				contentListColumns: { id: "broken:x", label: "x", cell: Noop },
			} as unknown as AdminExtensionSource[string],
			fine: { contentListColumns: [column({ id: "fine:ok" })] },
		});

		expect(selectContentListColumns(registry, posts).map((c) => c.id)).toEqual(["fine:ok"]);
		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining('contributions from plugin "broken"'),
		);
	});

	it("drops invalid metadata before it can break selection or host rendering", () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const registry = source({
			p: {
				contentListColumns: [
					{
						id: "p:bad-collections",
						label: "Bad collections",
						cell: Noop,
						collections: {},
					} as unknown as ContentListColumnExtension,
					{
						id: "p:bad-label",
						label: {},
						cell: Noop,
					} as unknown as ContentListColumnExtension,
					column({ id: "p:bad-order", order: Number.NaN }),
					{
						id: "p:bad-header",
						label: "Bad header",
						cell: Noop,
						header: "not-a-component",
					} as unknown as ContentListColumnExtension,
					column({ id: "p:valid" }),
				],
				contentEditorPanels: [
					{
						id: "p:bad-title",
						title: {},
						panel: Noop,
					} as unknown as ContentEditorPanelExtension,
					panel({ id: "p:valid-panel" }),
				],
			},
		});

		expect(selectContentListColumns(registry, posts).map((item) => item.id)).toEqual(["p:valid"]);
		expect(selectContentEditorPanels(registry, posts).map((item) => item.id)).toEqual([
			"p:valid-panel",
		]);
		expect(consoleWarn).toHaveBeenCalledTimes(5);
	});

	it("accepts React memo, forwardRef, and lazy component forms", () => {
		const MemoPanel = React.memo(() => null);
		const ForwardPanel = React.forwardRef<HTMLDivElement>(() => null);
		const LazyPanel = React.lazy(async () => ({ default: () => null }));
		const registry = source({
			p: {
				contentEditorPanels: [
					panel({ id: "p:memo", panel: MemoPanel }),
					panel({ id: "p:forward", panel: ForwardPanel }),
					panel({ id: "p:lazy", panel: LazyPanel }),
				],
			},
		});

		expect(selectContentEditorPanels(registry, posts).map((item) => item.id)).toEqual([
			"p:forward",
			"p:lazy",
			"p:memo",
		]);
	});

	it("rejects an invalid editor panel placement", () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const registry = source({
			p: {
				contentEditorPanels: [
					panel({ id: "p:bad", placement: "drawer" as "sidebar" }),
					panel({ id: "p:good", placement: "main" }),
				],
			},
		});

		expect(selectContentEditorPanels(registry, posts).map((item) => item.id)).toEqual(["p:good"]);
		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("placement"));
	});

	it("accepts named editor slots and rejects conflicting panel options", () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const registry = source({
			p: {
				contentEditorPanels: [
					panel({ id: "p:seo", slot: "seo", mode: "replace" }),
					panel({ id: "p:bad-slot", slot: "publish" as "seo" }),
					panel({ id: "p:bad-mode", slot: "seo", mode: "takeover" as "replace" }),
					panel({ id: "p:bad-placement", slot: "seo", placement: "sidebar" }),
					panel({ id: "p:bad-panel-mode", mode: "replace" }),
				],
			},
		});

		expect(selectContentEditorPanels(registry, posts).map((item) => item.id)).toEqual(["p:seo"]);
		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("slot"));
		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("mode"));
		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("named slots"));
	});
});

describe("disabled plugins", () => {
	it("skips every contribution from a disabled plugin", () => {
		const registry = source({
			active: { contentListColumns: [column({ id: "active:col" })] },
			paused: {
				contentListColumns: [column({ id: "paused:col" })],
				contentEditorPanels: [panel({ id: "paused:panel" })],
			},
		});
		const options = { ...posts, disabledPluginIds: new Set(["paused"]) };

		expect(selectContentListColumns(registry, options).map((c) => c.id)).toEqual(["active:col"]);
		expect(selectContentEditorPanels(registry, options)).toEqual([]);
	});

	it("lets a duplicate id fall to the next plugin when the first owner is disabled", () => {
		const registry = source({
			aaa: { contentListColumns: [column({ id: "shared" })] },
			zzz: { contentListColumns: [column({ id: "shared", order: 5 })] },
		});
		const selected = selectContentListColumns(registry, {
			...posts,
			disabledPluginIds: new Set(["aaa"]),
		});
		expect(selected).toHaveLength(1);
		expect(selected[0]?.order).toBe(5);
	});
});
