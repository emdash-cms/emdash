import { describe, expect, it } from "vitest";

import {
	injectBuiltinAuthRoutes,
	injectCoreRoutes,
} from "../../../src/astro/integration/routes.js";

/**
 * Collects every injectRoute call into a map keyed by pattern so the
 * test can assert specific patterns are (or aren't) registered without
 * caring about order or surrounding context.
 */
function collectRoutes(
	injector: (injectRoute: (opts: { pattern: string; entrypoint: unknown }) => void) => void,
): Map<string, unknown> {
	const routes = new Map<string, unknown>();
	injector(({ pattern, entrypoint }) => {
		routes.set(pattern, entrypoint);
	});
	return routes;
}

describe("TOTP route injection", () => {
	it("registers /setup/admin-totp", () => {
		const routes = collectRoutes(injectCoreRoutes);
		expect(routes.has("/_emdash/api/setup/admin-totp")).toBe(true);
	});

	it("registers /setup/admin-totp-verify", () => {
		const routes = collectRoutes(injectCoreRoutes);
		expect(routes.has("/_emdash/api/setup/admin-totp-verify")).toBe(true);
	});

	it("registers /auth/totp/login under builtin auth", () => {
		const routes = collectRoutes(injectBuiltinAuthRoutes);
		expect(routes.has("/_emdash/api/auth/totp/login")).toBe(true);
	});

	it("registers TOTP login next to the passkey login routes", () => {
		const routes = collectRoutes(injectBuiltinAuthRoutes);
		expect(routes.has("/_emdash/api/auth/passkey/verify")).toBe(true);
		expect(routes.has("/_emdash/api/auth/totp/login")).toBe(true);
	});
});
