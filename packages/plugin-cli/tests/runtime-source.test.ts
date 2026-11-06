import { describe, expect, it } from "vitest";

import { stripBuildOnlyMcp } from "../src/build/runtime-source.js";

describe("stripBuildOnlyMcp", () => {
	it("removes MCP-only schemas while preserving schemas used by routes", () => {
		const output = stripBuildOnlyMcp(
			`import { z } from "zod";
const mcpOnly = z.object({ query: z.string() });
const shared = z.object({ id: z.string() });
const plugin = {
	routes: { read: { handler: async (route) => shared.parse(route.input) } },
	mcp: { tools: { read: { route: "read", input: mcpOnly, output: shared } } }
};
export default plugin;
`,
			"plugin.ts",
		);

		expect(output).not.toContain("mcpOnly");
		expect(output).not.toContain("mcp:");
		expect(output).toContain("const shared = z.object");
		expect(output).toContain("shared.parse(route.input)");
	});

	it("handles an inline default object with satisfies", () => {
		const output = stripBuildOnlyMcp(
			`const input = schema();
export default {
	routes: { ping: async () => ({ ok: true }) },
	mcp: { tools: { ping: { route: "ping", input } } }
} satisfies SandboxedPlugin;
`,
			"plugin.ts",
		);

		expect(output).not.toContain("const input");
		expect(output).not.toContain("mcp:");
		expect(output).toContain("routes:");
	});
});
