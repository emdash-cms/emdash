import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	resolveContentEditorPanels,
	type ContentEditorPanelContext,
} from "../../src/lib/content-editor-panels";
import type { PluginAdmins } from "../../src/lib/plugin-context";

function Panel(_props: ContentEditorPanelContext) {
	return <div>Panel</div>;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("resolveContentEditorPanels", () => {
	it("selects enabled panels by collection and role", () => {
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{ id: "summary", title: "Summary", component: Panel, collections: ["posts"] },
					{ id: "pages", title: "Pages", component: Panel, collections: ["pages"] },
					{ id: "admin", title: "Admin", component: Panel, minRole: 50 },
				],
			},
		};

		expect(
			resolveContentEditorPanels(pluginAdmins, "posts", 40, {
				insights: { enabled: true },
			}),
		).toEqual([
			expect.objectContaining({
				pluginId: "insights",
				extension: expect.objectContaining({ id: "summary" }),
			}),
		]);
	});

	it("ignores disabled and stale registry modules", () => {
		const pluginAdmins: PluginAdmins = {
			enabled: {
				contentEditorPanels: [{ id: "kept", title: "Kept", component: Panel }],
			},
			disabled: {
				contentEditorPanels: [{ id: "disabled", title: "Disabled", component: Panel }],
			},
			stale: {
				contentEditorPanels: [{ id: "stale", title: "Stale", component: Panel }],
			},
		};

		expect(
			resolveContentEditorPanels(pluginAdmins, "posts", 50, {
				enabled: { enabled: true },
				disabled: { enabled: false },
			}),
		).toEqual([
			expect.objectContaining({
				pluginId: "enabled",
				extension: expect.objectContaining({ id: "kept" }),
			}),
		]);
	});

	it("orders panels deterministically and ignores duplicate ids per plugin", () => {
		const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const pluginAdmins: PluginAdmins = {
			zeta: {
				contentEditorPanels: [{ id: "later", title: "Later", component: Panel, order: 5 }],
			},
			alpha: {
				contentEditorPanels: [
					{ id: "first", title: "First", component: Panel, order: -1 },
					{ id: "first", title: "Duplicate", component: Panel, order: -2 },
				],
			},
		};

		expect(resolveContentEditorPanels(pluginAdmins, "posts", 50)).toMatchObject([
			{ pluginId: "alpha", extension: { id: "first" } },
			{ pluginId: "zeta", extension: { id: "later" } },
		]);
		expect(warningSpy).toHaveBeenCalledOnce();
	});

	it("contains collection predicate failures", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const pluginAdmins: PluginAdmins = {
			broken: {
				contentEditorPanels: [
					{
						id: "broken",
						title: "Broken",
						component: Panel,
						collections: () => {
							throw new Error("predicate failed");
						},
					},
				],
			},
		};

		expect(resolveContentEditorPanels(pluginAdmins, "posts", 50)).toEqual([]);
		expect(errorSpy).toHaveBeenCalledOnce();
	});

	it("ignores malformed panel exports without throwing", () => {
		const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const pluginAdmins = {
			broken: {
				contentEditorPanels: [
					{ id: "", title: "Missing id", component: Panel },
					{ id: "title", title: "", component: Panel },
					{ id: "component", title: "Component" },
					{ id: "order", title: "Order", component: Panel, order: Number.NaN },
				],
			},
		} as unknown as PluginAdmins;

		expect(resolveContentEditorPanels(pluginAdmins, "posts", 50)).toEqual([]);
		expect(warningSpy).toHaveBeenCalledTimes(4);
	});
});
