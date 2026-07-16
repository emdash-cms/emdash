import { describe, expect, it } from "vitest";

import {
	moveContentEditorPanel,
	parseContentEditorPanelLayout,
	placeContentEditorPanel,
	resolveContentEditorPanelLayout,
	type ContentEditorPanelLayout,
} from "../../src/lib/admin-editor-panel-layout";
import type { ContentEditorPanelExtension } from "../../src/lib/admin-extensions";

const Panel = () => null;

function panel(
	id: string,
	placement?: ContentEditorPanelExtension["placement"],
): ContentEditorPanelExtension {
	return { id, title: id, placement, panel: Panel };
}

const layout = (main: string[], sidebar: string[]): ContentEditorPanelLayout => ({
	version: 1,
	main,
	sidebar,
});

describe("parseContentEditorPanelLayout", () => {
	it("accepts the current version and rejects malformed browser data", () => {
		expect(parseContentEditorPanelLayout(JSON.stringify(layout(["a"], ["b"])))).toEqual(
			layout(["a"], ["b"]),
		);
		expect(parseContentEditorPanelLayout("not-json")).toBeNull();
		expect(parseContentEditorPanelLayout('{"version":2,"main":[],"sidebar":[]}')).toBeNull();
		expect(parseContentEditorPanelLayout('{"version":1,"main":[2],"sidebar":[]}')).toBeNull();
	});
});

describe("resolveContentEditorPanelLayout", () => {
	it("uses declared defaults when no preference exists", () => {
		expect(resolveContentEditorPanelLayout([panel("side"), panel("wide", "main")], null)).toEqual(
			layout(["wide"], ["side"]),
		);
	});

	it("preserves user order, drops stale/duplicate ids, and appends new panels", () => {
		const stored = layout(["b", "stale", "a"], ["a", "c"]);
		expect(
			resolveContentEditorPanelLayout(
				[panel("a"), panel("b", "main"), panel("c"), panel("new", "main")],
				stored,
			),
		).toEqual(layout(["b", "a", "new"], ["c"]));
	});
});

describe("panel layout moves", () => {
	it("moves within a surface without crossing its boundaries", () => {
		const start = layout(["a", "b"], ["c"]);
		expect(moveContentEditorPanel(start, "b", "up")).toEqual(layout(["b", "a"], ["c"]));
		expect(moveContentEditorPanel(start, "a", "up")).toBe(start);
		expect(moveContentEditorPanel(start, "missing", "down")).toBe(start);
	});

	it("moves a panel between surfaces and appends it to the destination", () => {
		expect(placeContentEditorPanel(layout(["a", "b"], ["c"]), "a", "sidebar")).toEqual(
			layout(["b"], ["c", "a"]),
		);
	});
});
