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
		mocks.batchQuery.mockResolvedValue([]);
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

	it("persists the bookmark when the request becomes authenticated mid-request", async () => {
		mocks.query.mockResolvedValue({ rows: [], bookmark: "do-bookmark-1" });
		const cookies = { get: vi.fn(), set: vi.fn() };
		const scoped = createRequestScopedDb({
			config: { binding: "DB_DO", session: "auto" },
			isAuthenticated: false,
			endedAuthenticated: () => true,
			isWrite: true,
			cookies,
			url: new URL("https://example.com/_emdash/api/auth/passkey/verify"),
		});

		expect(scoped).not.toBeNull();
		await sql`UPDATE users SET name = 'x'`.execute(scoped!.db);
		scoped!.commit();
		expect(cookies.set).toHaveBeenCalledWith(
			"__em_do_bookmark",
			"do-bookmark-1",
			expect.objectContaining({ httpOnly: true, secure: true }),
		);
	});

	it("persists nothing for a request that stays anonymous", async () => {
		mocks.query.mockResolvedValue({ rows: [], bookmark: "do-bookmark-1" });
		const cookies = { get: vi.fn(), set: vi.fn() };
		const scoped = createRequestScopedDb({
			config: { binding: "DB_DO", session: "auto" },
			isAuthenticated: false,
			endedAuthenticated: () => false,
			isWrite: true,
			cookies,
			url: new URL("https://example.com/comment"),
		});

		expect(scoped).not.toBeNull();
		await sql`UPDATE comments SET body = 'x'`.execute(scoped!.db);
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

	it("routes a required-primary read through the primary with sessions enabled", async () => {
		const scoped = createRequestScopedDb({
			config: { binding: "DB_DO", session: "auto" },
			isAuthenticated: false,
			isWrite: false,
			requirePrimary: true,
			cookies: { get: vi.fn(), set: vi.fn() },
			url: new URL("https://example.com/admin"),
		});

		expect(scoped).not.toBeNull();
		await sql`SELECT 1`.execute(scoped!.db);
		expect(mocks.query).toHaveBeenCalledWith("SELECT 1", [], { primary: true });
	});

	it("creates a primary-forced read scope when sessions are disabled", async () => {
		const scoped = createRequestScopedDb({
			config: { binding: "DB_DO", session: "disabled" },
			isAuthenticated: false,
			isWrite: false,
			requirePrimary: true,
			cookies: { get: vi.fn(), set: vi.fn() },
			url: new URL("https://example.com/admin"),
		});

		expect(scoped).not.toBeNull();
		await sql`SELECT 1`.execute(scoped!.db);
		expect(mocks.query).toHaveBeenCalledWith("SELECT 1", [], { primary: true });
	});

	it("combines an authenticated bookmark with primary routing", async () => {
		const cookies = { get: vi.fn(() => ({ value: "old-bookmark" })), set: vi.fn() };
		const scoped = createRequestScopedDb({
			config: { binding: "DB_DO", session: "auto" },
			isAuthenticated: true,
			isWrite: false,
			requirePrimary: true,
			cookies,
			url: new URL("https://example.com/admin"),
		});

		expect(scoped).not.toBeNull();
		await sql`SELECT 1`.execute(scoped!.db);
		expect(mocks.query).toHaveBeenCalledWith("SELECT 1", [], {
			bookmark: "old-bookmark",
			primary: true,
		});
	});

	it("routes every coalesced required-primary read through the primary", async () => {
		mocks.batchQuery.mockResolvedValue([{ rows: [] }, { rows: [] }]);
		const scoped = createRequestScopedDb({
			config: { binding: "DB_DO", session: "auto" },
			isAuthenticated: false,
			isWrite: false,
			requirePrimary: true,
			cookies: { get: vi.fn(), set: vi.fn() },
			url: new URL("https://example.com/admin"),
		});

		expect(scoped).not.toBeNull();
		await Promise.all([sql`SELECT 1`.execute(scoped!.db), sql`SELECT 2`.execute(scoped!.db)]);
		expect(mocks.batchQuery).toHaveBeenCalledWith(
			[
				{ sql: "SELECT 1", params: [] },
				{ sql: "SELECT 2", params: [] },
			],
			{ primary: true },
		);
	});

	it("leaves an ordinary anonymous session read replica-eligible", async () => {
		const scoped = createRequestScopedDb({
			config: { binding: "DB_DO", session: "auto" },
			isAuthenticated: false,
			isWrite: false,
			cookies: { get: vi.fn(), set: vi.fn() },
			url: new URL("https://example.com/"),
		});

		expect(scoped).not.toBeNull();
		await sql`SELECT 1`.execute(scoped!.db);
		expect(mocks.query).toHaveBeenCalledWith("SELECT 1", [], undefined);
	});
});
