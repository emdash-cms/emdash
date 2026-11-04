/**
 * Regression test for #962 (point 2): the EmDash integration must surface a
 * build-time warning when the host Astro config lacks `@astrojs/react`,
 * because the admin SPA silently fails to hydrate without it.
 */

import { describe, expect, it } from "vitest";

import { missingReactIntegrationWarning } from "../../../../src/astro/integration/index.js";

describe("missingReactIntegrationWarning (#962)", () => {
	it("returns undefined when @astrojs/react is registered", () => {
		expect(
			missingReactIntegrationWarning([{ name: "@astrojs/react" }, { name: "emdash" }]),
		).toBeUndefined();
	});

	it("warns with an actionable fix when @astrojs/react is missing", () => {
		const warning = missingReactIntegrationWarning([{ name: "emdash" }]);
		expect(warning).toContain("@astrojs/react");
		expect(warning).toContain("Loading EmDash...");
		expect(warning).toContain("integrations: [react(), emdash({ ... })]");
	});

	it("warns on an empty integrations list", () => {
		expect(missingReactIntegrationWarning([])).toContain("@astrojs/react");
	});
});
