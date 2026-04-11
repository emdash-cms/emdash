/**
 * Email Settings Route Registration Test
 *
 * Regression test for https://github.com/emdash-cms/emdash/issues/151
 * The email settings API route file existed but was never registered
 * via injectRoute(), causing the endpoint to return 404.
 */

import { describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";

describe("email settings route registration (#151)", () => {
	it("registers /_emdash/api/settings/email route", () => {
		const injectRoute = vi.fn();

		injectCoreRoutes(injectRoute);

		const patterns = injectRoute.mock.calls.map((call) => (call[0] as { pattern: string }).pattern);
		expect(patterns).toContain("/_emdash/api/settings/email");
	});
});
