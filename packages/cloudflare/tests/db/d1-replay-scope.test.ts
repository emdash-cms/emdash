import { CompiledQuery } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const trips: string[][] = [];
	const result = (sql: string) => ({
		success: true,
		results: [{ sql }],
		meta: { changes: 0, last_row_id: 0 },
	});
	const statement = (sql: string) => {
		const stmt = {
			sql,
			bind: () => stmt,
			all: async () => {
				trips.push([sql]);
				return result(sql);
			},
		};
		return stmt;
	};
	const flags = { failBatch: false };
	const session = {
		prepare: statement,
		batch: async (stmts: Array<{ sql: string }>) => {
			trips.push(stmts.map((s) => s.sql));
			if (flags.failBatch) throw new Error("batch rejected");
			return stmts.map((s) => result(s.sql));
		},
		getBookmark: () => null,
	};
	const binding = { prepare: statement, batch: session.batch, withSession: () => session };
	const env: Record<string, unknown> = { DB: binding };
	return { trips, binding, env, flags, waitUntil: vi.fn() };
});

vi.mock("cloudflare:workers", () => ({ env: mocks.env, waitUntil: mocks.waitUntil }));

import { createRequestScopedDb, type ResponseOutcome } from "../../src/db/d1.js";
import { MemoryPlanStore, type ReplayPlan } from "../../src/db/replay-plan-store.js";

const config = { binding: "DB", session: "auto" as const, coalesce: true, replay: true };

function anonymousPage(path: string, extra: Record<string, unknown> = {}) {
	return createRequestScopedDb({
		config,
		isAuthenticated: false,
		isWrite: false,
		canUseCachedBinding: true,
		htmlNavigation: true,
		buildId: "build-1",
		cookies: { get: vi.fn(), set: vi.fn() },
		url: new URL(`https://example.com${path}`),
		...extra,
	});
}

async function render(scoped: NonNullable<ReturnType<typeof anonymousPage>>) {
	await scoped.db.executeQuery(CompiledQuery.raw("select a"));
	await scoped.db.executeQuery(CompiledQuery.raw("select b where id = ?", [1]));
}

const PAGE: ResponseOutcome = {
	status: 200,
	contentType: "text/html; charset=utf-8",
	complete: true,
};

const STATE_KEY = Symbol.for("emdash:d1-replay");

/** Install a fresh isolate state so tests can seed and inspect stored plans. */
function freshState(): { memory: MemoryPlanStore; warm: boolean } {
	const state = { memory: new MemoryPlanStore(), warm: false };
	(globalThis as Record<symbol, unknown>)[STATE_KEY] = state;
	return state;
}

/** Wait for every background store operation the requests scheduled. */
async function settleStoreWrites() {
	await Promise.all(mocks.waitUntil.mock.calls.map(([p]) => p));
}

const COLD_KEY = "build-1:cold:example.com/posts/a";
const STORED: ReplayPlan = {
	v: 1,
	statements: [
		{ sql: "select a", params: [] },
		{ sql: "select b where id = ?", params: [1] },
	],
};

describe("D1 speculative replay", () => {
	beforeEach(() => {
		mocks.trips.length = 0;
		mocks.waitUntil.mockClear();
		mocks.flags.failBatch = false;
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("emdash:d1-replay")];
	});

	it("learns a path's plan and replays it as one round trip on the next cold render", async () => {
		const first = anonymousPage("/posts/a");
		await render(first!);
		first!.close?.(PAGE);
		await vi.waitFor(() => expect(mocks.waitUntil).toHaveBeenCalled());
		await Promise.all(mocks.waitUntil.mock.calls.map(([p]) => p));
		expect(mocks.trips).toEqual([["select a"], ["select b where id = ?"]]);

		// The isolate is warm now; reset it so the next render is a cold one.
		const state = (globalThis as Record<symbol, { warm: boolean }>)[
			Symbol.for("emdash:d1-replay")
		]!;
		state.warm = false;
		mocks.trips.length = 0;

		const second = anonymousPage("/posts/a");
		await render(second!);
		expect(mocks.trips).toEqual([["select a", "select b where id = ?"]]);
	});

	it("keys plans by path and build", async () => {
		const first = anonymousPage("/posts/a");
		await render(first!);
		first!.close?.(PAGE);
		await Promise.all(mocks.waitUntil.mock.calls.map(([p]) => p));
		const state = (globalThis as Record<symbol, { warm: boolean }>)[
			Symbol.for("emdash:d1-replay")
		]!;
		state.warm = false;
		mocks.trips.length = 0;

		await render(anonymousPage("/posts/b")!);
		await render(anonymousPage("/posts/a", { buildId: "build-2" })!);
		expect(mocks.trips.every((trip) => trip.length === 1)).toBe(true);
	});

	it.each([
		["a non-HTML request", { htmlNavigation: false }],
		["a request that may not use the public cache", { canUseCachedBinding: false }],
		["an authenticated request", { isAuthenticated: true }],
		["a request without a build id", { buildId: undefined }],
	])("does not replay or learn for %s", (_name, extra) => {
		const scoped = anonymousPage("/posts/a", extra);
		expect(scoped).not.toBeNull();
		expect(scoped!.close).toBeUndefined();
	});

	it("does nothing without coalescing", () => {
		const scoped = createRequestScopedDb({
			config: { ...config, coalesce: false },
			isAuthenticated: false,
			isWrite: false,
			canUseCachedBinding: true,
			htmlNavigation: true,
			buildId: "build-1",
			cookies: { get: vi.fn(), set: vi.fn() },
			url: new URL("https://example.com/"),
		});
		expect(scoped!.close).toBeUndefined();
	});
});

describe("D1 replay learning: response outcome", () => {
	beforeEach(() => {
		mocks.trips.length = 0;
		mocks.waitUntil.mockClear();
		mocks.flags.failBatch = false;
	});

	it.each<[string, ResponseOutcome | undefined]>([
		["a render that threw", undefined],
		["a redirect", { status: 302, contentType: null, complete: true }],
		["a 404 page", { status: 404, contentType: "text/html", complete: true }],
		["a 500 page", { status: 500, contentType: "text/html", complete: true }],
		["a non-HTML 200", { status: 200, contentType: "application/json", complete: true }],
		["a cut-off stream", { ...PAGE, complete: false }],
	])("writes no plan after %s", async (_name, outcome) => {
		const state = freshState();
		const scoped = anonymousPage("/posts/a");
		await render(scoped!);
		scoped!.close?.(outcome);
		await settleStoreWrites();
		expect(state.memory.size).toBe(0);
		expect(mocks.waitUntil).not.toHaveBeenCalled();
	});

	it("learns from a fully streamed 2xx HTML page", async () => {
		const state = freshState();
		const scoped = anonymousPage("/posts/a");
		await render(scoped!);
		scoped!.close?.({ status: 203, contentType: "TEXT/HTML", complete: true });
		await settleStoreWrites();
		expect(state.memory.peek(COLD_KEY)?.statements.map((s) => s.sql)).toEqual([
			"select a",
			"select b where id = ?",
		]);
	});

	it.each<[string, ResponseOutcome | undefined]>([
		["a render that threw", undefined],
		["a redirect", { status: 301, contentType: null, complete: true }],
		["a 500 page", { status: 500, contentType: "text/html", complete: true }],
	])(
		"leaves a stored plan untouched after %s, even if it ran other queries",
		async (_n, outcome) => {
			const state = freshState();
			await state.memory.put(COLD_KEY, STORED);
			const scoped = anonymousPage("/posts/a");
			await scoped!.db.executeQuery(CompiledQuery.raw("select error_page"));
			scoped!.close?.(outcome);
			await settleStoreWrites();
			expect(state.memory.peek(COLD_KEY)).toBe(STORED);
		},
	);

	it("deletes a stored plan when the path now 404s, without learning the 404's queries", async () => {
		const state = freshState();
		await state.memory.put(COLD_KEY, STORED);
		const scoped = anonymousPage("/posts/a");
		await scoped!.db.executeQuery(CompiledQuery.raw("select not_found_layout"));
		scoped!.close?.({ status: 404, contentType: "text/html", complete: true });
		await settleStoreWrites();
		expect(state.memory.size).toBe(0);
	});

	it("does not touch the store for a 404 on a path that never had a plan", async () => {
		const state = freshState();
		const scoped = anonymousPage("/nope");
		await render(scoped!);
		scoped!.close?.({ status: 404, contentType: "text/html", complete: true });
		await settleStoreWrites();
		expect(state.memory.size).toBe(0);
		expect(mocks.waitUntil).not.toHaveBeenCalled();
	});
});

describe("D1 replay learning: query strings", () => {
	beforeEach(() => {
		mocks.trips.length = 0;
		mocks.waitUntil.mockClear();
		mocks.flags.failBatch = false;
	});

	it("does not learn from a request with a query string", async () => {
		const state = freshState();
		const scoped = anonymousPage("/search?q=a");
		await render(scoped!);
		scoped!.close?.(PAGE);
		await settleStoreWrites();
		expect(state.memory.size).toBe(0);
		expect(mocks.waitUntil).not.toHaveBeenCalled();
	});

	it("still replays the path's plan, serving hits and running misses, without rewriting it", async () => {
		const state = freshState();
		await state.memory.put(COLD_KEY, STORED);
		const scoped = anonymousPage("/posts/a?page=2");
		await render(scoped!);
		await scoped!.db.executeQuery(CompiledQuery.raw("select c"));
		expect(mocks.trips).toEqual([["select a", "select b where id = ?"], ["select c"]]);
		scoped!.close?.(PAGE);
		await settleStoreWrites();
		expect(state.memory.peek(COLD_KEY)).toBe(STORED);
		expect(mocks.waitUntil).not.toHaveBeenCalled();
	});

	it("does not delete the plan when its batch fails", async () => {
		const state = freshState();
		await state.memory.put(COLD_KEY, STORED);
		mocks.flags.failBatch = true;
		const scoped = anonymousPage("/posts/a?x=1");
		await render(scoped!);
		scoped!.close?.(PAGE);
		await settleStoreWrites();
		expect(state.memory.peek(COLD_KEY)).toBe(STORED);
		expect(mocks.waitUntil).not.toHaveBeenCalled();
	});

	it("does not delete the plan on a 404", async () => {
		const state = freshState();
		await state.memory.put(COLD_KEY, STORED);
		const scoped = anonymousPage("/posts/a?x=1");
		await render(scoped!);
		scoped!.close?.({ status: 404, contentType: "text/html", complete: true });
		await settleStoreWrites();
		expect(state.memory.peek(COLD_KEY)).toBe(STORED);
	});

	it("a batch failure without a query string still drops the plan", async () => {
		const state = freshState();
		await state.memory.put(COLD_KEY, STORED);
		mocks.flags.failBatch = true;
		const scoped = anonymousPage("/posts/a");
		await scoped!.db.executeQuery(CompiledQuery.raw("select a"));
		await vi.waitFor(() => expect(mocks.waitUntil).toHaveBeenCalled());
		await settleStoreWrites();
		expect(state.memory.peek(COLD_KEY)).toBeNull();
	});
});

describe("D1 replay: hosts listed in EMDASH_REPLAY_OFF_HOSTS", () => {
	beforeEach(() => {
		mocks.trips.length = 0;
		mocks.waitUntil.mockClear();
		mocks.flags.failBatch = false;
		mocks.env.EMDASH_REPLAY_OFF_HOSTS = "off.example.com, other.example.com";
	});

	afterEach(() => {
		delete mocks.env.EMDASH_REPLAY_OFF_HOSTS;
	});

	const offPage = (path: string) =>
		anonymousPage(path, { url: new URL(`https://off.example.com${path}`) });

	it("renders a listed host without replaying its stored plan or learning a new one", async () => {
		const state = freshState();
		await state.memory.put("build-1:cold:off.example.com/posts/a", STORED);
		const scoped = offPage("/posts/a");
		await render(scoped!);
		expect(mocks.trips).toEqual([["select a"], ["select b where id = ?"]]);
		scoped!.close?.(PAGE);
		await settleStoreWrites();
		expect(mocks.waitUntil).not.toHaveBeenCalled();
		expect(state.memory.size).toBe(1);
	});

	it("still marks the isolate warm, so the next replaying render uses the warm plan", async () => {
		const state = freshState();
		await state.memory.put(COLD_KEY, STORED);
		const off = offPage("/posts/a");
		await render(off!);
		off!.close?.(PAGE);
		expect(state.warm).toBe(true);

		mocks.trips.length = 0;
		await render(anonymousPage("/posts/a")!);
		expect(mocks.trips).toEqual([["select a"], ["select b where id = ?"]]);
	});

	it("keeps replaying hosts that are not listed", async () => {
		const state = freshState();
		await state.memory.put(COLD_KEY, STORED);
		await render(anonymousPage("/posts/a")!);
		expect(mocks.trips).toEqual([["select a", "select b where id = ?"]]);
	});
});

describe("D1 replay learning: params listed in EMDASH_REPLAY_IGNORE_PARAMS", () => {
	beforeEach(() => {
		mocks.trips.length = 0;
		mocks.waitUntil.mockClear();
		mocks.flags.failBatch = false;
		mocks.env.EMDASH_REPLAY_IGNORE_PARAMS = "_perf_cold, utm_source";
	});

	afterEach(() => {
		delete mocks.env.EMDASH_REPLAY_IGNORE_PARAMS;
	});

	it("learns from a request whose query string has only listed params", async () => {
		const state = freshState();
		const scoped = anonymousPage("/posts/a?_perf_cold=123&utm_source=x");
		await render(scoped!);
		scoped!.close?.(PAGE);
		await settleStoreWrites();
		expect(state.memory.peek(COLD_KEY)?.statements.map((s) => s.sql)).toEqual([
			"select a",
			"select b where id = ?",
		]);
	});

	it("does not learn when any param is unlisted", async () => {
		const state = freshState();
		const scoped = anonymousPage("/posts/a?_perf_cold=123&page=2");
		await render(scoped!);
		scoped!.close?.(PAGE);
		await settleStoreWrites();
		expect(state.memory.size).toBe(0);
		expect(mocks.waitUntil).not.toHaveBeenCalled();
	});
});
