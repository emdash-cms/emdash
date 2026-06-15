import { describe, expect, it } from "vitest";

import { pluginToolName } from "../../../src/mcp/plugin-tool-name.js";

const HASHED_TOOL_NAME_PATTERN = /^[a-z0-9_]+__[0-9a-f]{8}__[a-z][a-z0-9_]*$/;

describe("pluginToolName", () => {
	it("uses readable names for unambiguous scoped plugin IDs", () => {
		expect(pluginToolName("@emdash-cms/plugin-forms", "submit_form")).toBe(
			"emdash_cms__plugin_forms__submit_form",
		);
	});

	it("adds a stable hash when dashes make a segment ambiguous", () => {
		const name = pluginToolName("foo--bar", "summarize");

		expect(name).toMatch(HASHED_TOOL_NAME_PATTERN);
		expect(name).not.toBe("foo__bar__summarize");
		expect(pluginToolName("foo--bar", "summarize")).toBe(name);
	});

	it("keeps scoped IDs distinct when dashes sit next to the slash boundary", () => {
		const trailingDashScope = pluginToolName("@a-/b", "summarize");
		const leadingDashName = pluginToolName("@a/-b", "summarize");

		expect(trailingDashScope).toMatch(HASHED_TOOL_NAME_PATTERN);
		expect(leadingDashName).toMatch(HASHED_TOOL_NAME_PATTERN);
		expect(trailingDashScope).not.toBe(leadingDashName);
	});
});
