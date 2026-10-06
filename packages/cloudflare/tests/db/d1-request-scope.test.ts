import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const session = {
		prepare: vi.fn(),
		batch: vi.fn(),
		getBookmark: vi.fn(() => "d1-bookmark-1"),
	};
	const binding = {
		prepare: vi.fn(),
		batch: vi.fn(),
		withSession: vi.fn(() => session),
	};
	return { session, binding };
});

vi.mock("cloudflare:workers", () => ({
	env: { DB: mocks.binding },
}));

import { createRequestScopedDb } from "../../src/db/d1.js";

const config = { binding: "DB", session: "auto" as const };

describe("D1 request scoping bookmark persistence", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.session.getBookmark.mockReturnValue("d1-bookmark-1");
		mocks.binding.withSession.mockReturnValue(mocks.session);
	});

	it("persists the bookmark for a request that started authenticated", () => {
		const cookies = { get: vi.fn(), set: vi.fn() };
		const scoped = createRequestScopedDb({
			config,
			isAuthenticated: true,
			isWrite: false,
			cookies,
			url: new URL("https://example.com/_emdash/admin"),
		});

		expect(scoped).not.toBeNull();
		scoped!.commit();
		expect(cookies.set).toHaveBeenCalledWith(
			"__em_d1_bookmark",
			"d1-bookmark-1",
			expect.objectContaining({ httpOnly: true, secure: true }),
		);
	});

	it("persists the bookmark when the request becomes authenticated mid-request", () => {
		const cookies = { get: vi.fn(), set: vi.fn() };
		const scoped = createRequestScopedDb({
			config,
			isAuthenticated: false,
			endedAuthenticated: () => true,
			isWrite: true,
			cookies,
			url: new URL("https://example.com/_emdash/api/auth/passkey/verify"),
		});

		expect(scoped).not.toBeNull();
		scoped!.commit();
		expect(cookies.set).toHaveBeenCalledWith(
			"__em_d1_bookmark",
			"d1-bookmark-1",
			expect.objectContaining({ httpOnly: true, secure: true }),
		);
	});

	it("persists nothing for a request that stays anonymous", () => {
		const cookies = { get: vi.fn(), set: vi.fn() };
		const scoped = createRequestScopedDb({
			config,
			isAuthenticated: false,
			endedAuthenticated: () => false,
			isWrite: false,
			cookies,
			url: new URL("https://example.com/"),
		});

		expect(scoped).not.toBeNull();
		scoped!.commit();
		expect(cookies.set).not.toHaveBeenCalled();
	});
});

describe("D1 request scoping query concurrency", () => {
	/** Statements the session received in its first round trip, while that trip is still pending. */
	async function firstRoundTrip(coalesce: boolean) {
		const trips: string[][] = [];
		let release!: () => void;
		const pending = new Promise<void>((resolve) => (release = resolve));
		const result = { success: true, results: [], meta: { changes: 0, last_row_id: 0 } };
		const statement = (sql: string) => {
			const stmt = {
				sql,
				bind: () => stmt,
				all: async () => {
					trips.push([sql]);
					await pending;
					return result;
				},
			};
			return stmt;
		};
		const session = {
			prepare: statement,
			batch: async (stmts: { sql: string }[]) => {
				trips.push(stmts.map((s) => s.sql));
				await pending;
				return stmts.map(() => result);
			},
			getBookmark: () => null,
		};
		mocks.binding.withSession.mockReturnValue(session as never);

		const scoped = createRequestScopedDb({
			config: { ...config, coalesce },
			isAuthenticated: false,
			isWrite: false,
			cookies: { get: vi.fn(), set: vi.fn() },
			url: new URL("https://example.com/"),
		})!;
		const reads = Promise.all([
			scoped.db.selectFrom("a").selectAll().execute(),
			scoped.db.selectFrom("b").selectAll().execute(),
		]);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const first = trips[0]?.length ?? 0;
		release();
		await reads;
		return { scoped, first };
	}

	it.each([false, true])(
		"reports multiple connections exactly when concurrent reads share a round trip (coalesce: %s)",
		async (coalesce) => {
			const { scoped, first } = await firstRoundTrip(coalesce);
			expect(first).toBeGreaterThan(0);
			expect(scoped.db.getExecutor().adapter.supportsMultipleConnections).toBe(first > 1);
		},
	);
});
