/**
 * Verifies that MCP route injection is opt-in (mcp: true),
 * not opt-out (mcp !== false).
 *
 * Regression test for https://github.com/emdash-cms/emdash/issues/1228
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const integrationSource = readFileSync(
	resolve(
		import.meta.dirname,
		"../../../src/astro/integration/index.ts",
	),
	"utf-8",
);

describe("MCP default", () => {
	it("should require explicit opt-in (mcp === true), not opt-out (mcp !== false)", () => {
		expect(integrationSource).toContain("resolvedConfig.mcp === true");
		expect(integrationSource).not.toContain("resolvedConfig.mcp !== false");
	});
});
