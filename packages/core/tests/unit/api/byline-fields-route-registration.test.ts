/**
 * Byline-fields route registration test (Phase 4 of Discussion #1174).
 *
 * Regression guard mirroring `email-settings-route.test.ts` (#151).
 * Route files under `src/astro/routes/` are only reachable in real
 * integrated apps if `injectCoreRoutes` calls `injectRoute` for them —
 * the directory layout alone does nothing. This test asserts that
 * every byline-fields endpoint is wired up.
 *
 * Order matters too: the static `/byline-fields/reorder` route must be
 * registered before the dynamic `/byline-fields/[slug]` route so
 * Astro's resolver dispatches POST /byline-fields/reorder to the
 * reorder handler instead of treating "reorder" as a slug. The
 * `reorder` slug is also reserved at the data layer
 * (RESERVED_BYLINE_FIELD_SLUGS) for defence in depth, but route
 * ordering is the primary mechanism.
 */

import { describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";

interface InjectRouteCall {
	pattern: string;
	entrypoint: string;
}

describe("byline-fields route registration (Phase 4)", () => {
	function collectPatterns(): { patterns: string[]; ordered: InjectRouteCall[] } {
		const injectRoute = vi.fn();
		injectCoreRoutes(injectRoute);
		const calls = injectRoute.mock.calls.map((call) => call[0] as InjectRouteCall);
		return { patterns: calls.map((c) => c.pattern), ordered: calls };
	}

	it("registers list / create at /_emdash/api/admin/byline-fields", () => {
		const { patterns } = collectPatterns();
		expect(patterns).toContain("/_emdash/api/admin/byline-fields");
	});

	it("registers single-field CRUD at /_emdash/api/admin/byline-fields/[slug]", () => {
		const { patterns } = collectPatterns();
		expect(patterns).toContain("/_emdash/api/admin/byline-fields/[slug]");
	});

	it("registers reorder at /_emdash/api/admin/byline-fields/reorder", () => {
		const { patterns } = collectPatterns();
		expect(patterns).toContain("/_emdash/api/admin/byline-fields/reorder");
	});

	it("registers usage at /_emdash/api/admin/byline-fields/[slug]/usage", () => {
		const { patterns } = collectPatterns();
		expect(patterns).toContain("/_emdash/api/admin/byline-fields/[slug]/usage");
	});

	it("registers the static `reorder` route before the dynamic `[slug]` route", () => {
		// Astro's route resolver picks static over dynamic, but the
		// `routes.ts` ordering still matters for build determinism and
		// matches the convention used by every other reorder/[slug]
		// pairing in the file (see schema/collections/[slug]/fields/).
		const { patterns } = collectPatterns();
		const reorderIdx = patterns.indexOf("/_emdash/api/admin/byline-fields/reorder");
		const slugIdx = patterns.indexOf("/_emdash/api/admin/byline-fields/[slug]");
		expect(reorderIdx).toBeGreaterThanOrEqual(0);
		expect(slugIdx).toBeGreaterThanOrEqual(0);
		expect(reorderIdx).toBeLessThan(slugIdx);
	});
});
