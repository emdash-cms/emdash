/**
 * Verifies that MCP route injection is opt-in (mcp: true),
 * not opt-out (mcp !== false).
 *
 * Regression test for https://github.com/emdash-cms/emdash/issues/1228
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { describe, it, expect } from "vitest";

const integrationSource = readFileSync(
	resolve(__dirname, "../../../src/astro/integration/index.ts"),
	"utf-8",
);

describe("MCP default", () => {
	it("should require explicit opt-in (mcp === true), not opt-out (mcp !== false)", () => {
		expect(integrationSource).toContain("resolvedConfig.mcp === true");
		expect(integrationSource).not.toContain("resolvedConfig.mcp !== false");
	});
});
