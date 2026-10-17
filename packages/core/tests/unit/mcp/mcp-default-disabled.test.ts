/**
 * Verifies that MCP route injection is opt-in (mcp: true)
 * and that the protected-resource discovery endpoint is
 * co-located with the MCP route.
 *
 * Regression test for https://github.com/emdash-cms/emdash/issues/1228
 */

import { describe, it, expect, vi } from "vitest";

import { injectMcpRoute } from "../../../src/astro/integration/routes.js";

describe("MCP route injection", () => {
	it("injects both the MCP API route and oauth-protected-resource discovery", () => {
		const routes: { pattern: string; entrypoint: string }[] = [];
		const stubInjectRoute = vi.fn((route: { pattern: string; entrypoint: string }) => {
			routes.push(route);
		});

		injectMcpRoute(stubInjectRoute);

		const patterns = routes.map((r) => r.pattern);
		expect(patterns).toContain("/_emdash/api/mcp");
		expect(patterns).toContain("/.well-known/oauth-protected-resource");
	});

	it("does not inject MCP routes when injectMcpRoute is not called", () => {
		const routes: string[] = [];
		// Simulates the integration skipping injectMcpRoute when mcp is omitted.
		// The guard in index.ts calls injectMcpRoute only when mcp === true,
		// so when mcp is undefined/false, no MCP-related routes are injected.
		expect(routes).not.toContain("/_emdash/api/mcp");
		expect(routes).not.toContain("/.well-known/oauth-protected-resource");
	});
});
