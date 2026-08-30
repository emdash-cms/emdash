/**
 * Durable Object playground database -- RUNTIME ENTRY
 *
 * Provides a createDialect() that the virtual module system expects,
 * plus re-exports the DO class and playground middleware.
 *
 * In playground mode, the actual DB connection is always set by the
 * playground middleware via ALS (runWithContext). The createDialect
 * here creates a "dummy" dialect that will be overridden per-request.
 * If a query somehow runs without the middleware's ALS override,
 * the dialect throws a clear error.
 *
 * This module imports from cloudflare:workers transitively.
 * Do NOT import this at config time.
 */

import type { Dialect } from "kysely";

import { PreviewDODialect } from "./do-dialect.js";
import type { PreviewDBStub } from "./do-dialect.js";
import type { PreviewDOConfig } from "./do-types.js";

/**
 * Create a playground DO dialect from config.
 *
 * Returns a dialect that throws if any query is executed outside of
 * the playground middleware's ALS context. In normal operation, the
 * middleware overrides this DB via runWithContext() on every request.
 *
 * This factory exists to satisfy the virtual module system's
 * createDialect() contract. The EmDash runtime creates a singleton
 * DB from it, but all actual queries go through the ALS-scoped DB.
 */
export function createDialect(_config: PreviewDOConfig): Dialect {
	const notInitialized: PreviewDBStub = {
		async query(): Promise<{ rows: Record<string, unknown>[] }> {
			throw new Error(
				"Playground database not initialized. " +
					"Ensure the playground middleware is registered in src/middleware.ts " +
					"and all requests go through it.",
			);
		},
	};

	return new PreviewDODialect({ getStub: () => notInitialized });
}

export { EmDashPreviewDB } from "./do-class.js";
export { isBlockedInPlayground } from "./do-playground-routes.js";
