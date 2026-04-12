import type { Database } from "emdash";
import { Kysely } from "kysely";
import { describe, it, expect } from "vitest";

import { PreviewDODialect } from "../../src/db/do-dialect.js";
import type { PreviewDBStub } from "../../src/db/do-dialect.js";

/**
 * Recreates the playground's dummy dialect logic inline to avoid
 * importing playground.ts which re-exports do-class.ts (cloudflare:workers).
 */
function createTestDialect() {
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

describe("playground dummy dialect", () => {
	it("creates a dialect without throwing", () => {
		const dialect = createTestDialect();
		expect(dialect).toBeDefined();
		expect(dialect.createAdapter).toBeTypeOf("function");
		expect(dialect.createDriver).toBeTypeOf("function");
		expect(dialect.createQueryCompiler).toBeTypeOf("function");
	});

	it("throws when a query is executed (no middleware ALS override)", async () => {
		const dialect = createTestDialect();
		const db = new Kysely<Database>({ dialect });

		await expect(
			db
				.selectFrom("users" as any)
				.selectAll()
				.execute(),
		).rejects.toThrow("Playground database not initialized");
	});
});
