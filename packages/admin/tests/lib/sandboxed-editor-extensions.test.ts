import { describe, expect, it } from "vitest";

import type { AdminManifest } from "../../src/lib/api/client.js";
import {
	editorExtensionUrl,
	resolveSandboxedEditorActions,
	resolveSandboxedEditorPanels,
} from "../../src/lib/sandboxed-editor-extensions.js";

describe("sandboxed editor extension resolution", () => {
	const plugins: AdminManifest["plugins"] = {
		zeta: {
			enabled: true,
			adminMode: "blocks",
			editorPanels: [
				{ id: "later", title: "Later", route: "later", order: 10 },
				{ id: "posts", title: "Posts", route: "posts", collections: ["posts"] },
			],
			editorActions: [{ id: "refresh", label: "Refresh", route: "refresh", placement: "toolbar" }],
		},
		alpha: {
			enabled: true,
			adminMode: "blocks",
			editorPanels: [{ id: "first", title: "First", route: "first" }],
			editorActions: [{ id: "inspect", label: "Inspect", route: "inspect", placement: "overflow" }],
		},
		disabled: {
			enabled: false,
			adminMode: "blocks",
			editorPanels: [{ id: "hidden", title: "Hidden", route: "hidden" }],
		},
		native: {
			enabled: true,
			adminMode: "react",
			editorActions: [{ id: "hidden", label: "Hidden", route: "hidden", placement: "toolbar" }],
		},
	};

	it("filters by enabled Block Kit plugins and collection, then sorts deterministically", () => {
		expect(resolveSandboxedEditorPanels(plugins, "pages")).toMatchObject([
			{ pluginId: "alpha", extension: { id: "first" } },
			{ pluginId: "zeta", extension: { id: "later" } },
		]);
		expect(resolveSandboxedEditorPanels(plugins, "posts")).toMatchObject([
			{ pluginId: "alpha", extension: { id: "first" } },
			{ pluginId: "zeta", extension: { id: "posts" } },
			{ pluginId: "zeta", extension: { id: "later" } },
		]);
		expect(resolveSandboxedEditorActions(plugins, "posts")).toMatchObject([
			{ pluginId: "alpha", extension: { id: "inspect" } },
			{ pluginId: "zeta", extension: { id: "refresh" } },
		]);
	});

	it("encodes every path selector and keeps content locale separate", () => {
		expect(editorExtensionUrl("posts", "id/1", "publisher/plugin", "panel", "health", "ar")).toBe(
			"/_emdash/api/content/posts/id%2F1/plugin-extensions/publisher%2Fplugin/panel/health?locale=ar",
		);
	});
});
