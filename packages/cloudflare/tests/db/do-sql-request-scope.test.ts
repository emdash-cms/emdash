import { sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const query = vi.fn().mockResolvedValue({ rows: [] });
	const batchQuery = vi.fn().mockResolvedValue([]);
	const stub = { query, batchQuery };
	const namespace = {
		idFromName: vi.fn(() => "emdash-id"),
		get: vi.fn(() => stub),
	};
	return { query, batchQuery, stub, namespace };
});

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;

		constructor(ctx: unknown) {
			this.ctx = ctx;
		}
	},
	env: { DB_DO: mocks.namespace },
}));

import { createRequestScopedDb } from "../../src/db/do-sql.js";

describe("DO SQL request scoping", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.query.mockResolvedValue({ rows: [] });
	});

	it("creates a primary-forced scope for a write when replica sessions are disabled", async () => {
		const cookies = { get: vi.fn(), set: vi.fn() };
		const scoped = createRequestScopedDb({
			config: { binding: "DB_DO", session: "disabled" },
			isAuthenticated: true,
			isWrite: true,
			cookies,
			url: new URL("https://example.com/_emdash/api/schema"),
		});

		expect(scoped).not.toBeNull();
		await sql`SELECT 1`.execute(scoped!.db);
		expect(mocks.query).toHaveBeenCalledWith("SELECT 1", [], { primary: true });
		scoped!.commit();
		expect(cookies.set).not.toHaveBeenCalled();
	});

	it("keeps anonymous reads on the singleton when replica sessions are disabled", () => {
		expect(
			createRequestScopedDb({
				config: { binding: "DB_DO", session: "disabled" },
				isAuthenticated: false,
				isWrite: false,
				cookies: { get: vi.fn(), set: vi.fn() },
				url: new URL("https://example.com/"),
			}),
		).toBeNull();
	});
});
