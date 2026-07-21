import { describe, expect, it } from "vitest";

import { pluginToolName } from "../../../src/mcp/plugin-tool-name.js";

const HASHED_TOOL_NAME_PATTERN = /^[a-z0-9_]+__[0-9a-f]{8}__[a-z][a-z0-9_]*$/;

describe("pluginToolName", () => {
	it("uses readable names for unambiguous scoped plugin IDs", () => {
		expect(pluginToolName("@emdash-cms/plugin-forms", "submit_form")).toBe(
			"emdash_cms__plugin_forms__submit_form",
		);
	});

	it("preserves existing names for already MCP-safe plugin IDs", () => {
		expect(pluginToolName("calendar-plugin", "createEvent")).toBe("calendar-plugin__createEvent");
		expect(pluginToolName("foo--bar", "summarize")).toBe("foo--bar__summarize");
	});

	it("hashes safe-looking IDs with ambiguous separators", () => {
		expect(pluginToolName("foo__bar", "summarize")).toMatch(HASHED_TOOL_NAME_PATTERN);
	});

	it("keeps scoped IDs distinct when dashes sit next to the slash boundary", () => {
		const trailingDashScope = pluginToolName("@a-/b", "summarize");
		const leadingDashName = pluginToolName("@a/-b", "summarize");

		expect(trailingDashScope).toMatch(HASHED_TOOL_NAME_PATTERN);
		expect(leadingDashName).toMatch(HASHED_TOOL_NAME_PATTERN);
		expect(trailingDashScope).not.toBe(leadingDashName);
	});

	it("keeps normalized dashes distinct from literal underscores", () => {
		expect(pluginToolName("foo-bar", "summarize")).not.toBe(pluginToolName("foo_bar", "summarize"));
	});
});
