import { describe, expect, it } from "vitest";

import {
	boundPlan,
	CachePlanStore,
	LayeredPlanStore,
	MAX_PLAN_STATEMENTS,
	MemoryPlanStore,
	parseReplayPlan,
	type ReplayPlan,
} from "../../src/db/replay-plan-store.js";

const planA: ReplayPlan = { v: 1, statements: [{ sql: "select a where id = ?", params: [1] }] };
const planB: ReplayPlan = { v: 1, statements: [{ sql: "select b", params: [] }] };

/** Map-backed stand-in for a Workers `Cache`. */
function fakeCache() {
	const entries = new Map<string, string>();
	const cache = {
		async match(url: string) {
			const body = entries.get(url);
			return body === undefined ? undefined : new Response(body);
		},
		async put(url: string, response: Response) {
			entries.set(url, await response.text());
		},
		async delete(url: string) {
			return entries.delete(url);
		},
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- implements the Cache subset the store uses
	return { cache: cache as unknown as Cache, entries };
}

describe("parseReplayPlan", () => {
	it("accepts a valid plan", () => {
		expect(parseReplayPlan(JSON.parse(JSON.stringify(planA)))).toEqual(planA);
	});

	it.each([
		["a non-object", "nope"],
		["another version", { v: 2, statements: planA.statements }],
		["no statements", { v: 1, statements: [] }],
		["a write", { v: 1, statements: [{ sql: "delete from a", params: [] }] }],
		["a CTE", { v: 1, statements: [{ sql: "with x as (select 1) delete from a", params: [] }] }],
		["two statements", { v: 1, statements: [{ sql: "select 1; drop table a", params: [] }] }],
		["object params", { v: 1, statements: [{ sql: "select ?", params: [{ x: 1 }] }] }],
		["missing params", { v: 1, statements: [{ sql: "select 1" }] }],
		[
			"too many statements",
			{
				v: 1,
				statements: Array.from({ length: MAX_PLAN_STATEMENTS + 1 }, () => ({
					sql: "select 1",
					params: [],
				})),
			},
		],
	])("rejects %s", (_name, value) => {
		expect(parseReplayPlan(value)).toBeNull();
	});
});

describe("boundPlan", () => {
	it("keeps statements in order up to the statement bound", () => {
		const statements = Array.from({ length: MAX_PLAN_STATEMENTS + 5 }, (_, i) => ({
			sql: `select ${i}`,
			params: [],
		}));
		const plan = boundPlan(statements);
		expect(plan?.statements).toHaveLength(MAX_PLAN_STATEMENTS);
		expect(plan?.statements[0]?.sql).toBe("select 0");
	});

	it("stops at the byte bound", () => {
		const big = "x".repeat(20 * 1024);
		const plan = boundPlan(Array.from({ length: 5 }, () => ({ sql: "select ?", params: [big] })));
		expect(plan?.statements).toHaveLength(3);
	});

	it("returns null when nothing is replayable", () => {
		expect(boundPlan([{ sql: "update a set b = 1", params: [] }])).toBeNull();
	});
});

describe("MemoryPlanStore", () => {
	it("evicts the least recently used plan", async () => {
		const store = new MemoryPlanStore(2);
		await store.put("a", planA);
		await store.put("b", planB);
		expect(store.peek("a")).toEqual(planA);
		await store.put("c", planB);

		expect(store.peek("b")).toBeNull();
		expect(store.peek("a")).toEqual(planA);
		expect(store.size).toBe(2);
	});
});

describe("CachePlanStore", () => {
	it("round-trips a plan under a synthetic path on the site's origin", async () => {
		const { cache, entries } = fakeCache();
		const store = new CachePlanStore(cache, "https://example.com");

		await store.put("123:cold:example.com/posts/a", planA);

		expect([...entries.keys()]).toEqual([
			"https://example.com/_emdash/.replay-plan/123%3Acold%3Aexample.com%2Fposts%2Fa",
		]);
		expect(await store.get("123:cold:example.com/posts/a")).toEqual(planA);
		await store.delete("123:cold:example.com/posts/a");
		expect(await store.get("123:cold:example.com/posts/a")).toBeNull();
	});

	it("treats a poisoned entry as no plan", async () => {
		const { cache, entries } = fakeCache();
		const store = new CachePlanStore(cache, "https://example.com");
		await store.put("k", planA);
		const [url] = [...entries.keys()];
		entries.set(url!, JSON.stringify({ v: 1, statements: [{ sql: "delete from a", params: [] }] }));

		expect(await store.get("k")).toBeNull();
	});

	it("degrades to no plan without a cache or when it throws", async () => {
		expect(await new CachePlanStore(null, "https://example.com").get("k")).toBeNull();
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately broken cache
		const broken = {
			match: async () => {
				throw new Error("boom");
			},
		} as unknown as Cache;
		expect(await new CachePlanStore(broken, "https://example.com").get("k")).toBeNull();
	});
});

describe("LayeredPlanStore", () => {
	it("backfills memory from the shared store and writes through to both", async () => {
		const memory = new MemoryPlanStore();
		const { cache } = fakeCache();
		const shared = new CachePlanStore(cache, "https://example.com");
		await shared.put("k", planA);
		const store = new LayeredPlanStore(memory, shared);

		expect(await store.get("k")).toEqual(planA);
		expect(memory.peek("k")).toEqual(planA);

		await store.put("k2", planB);
		expect(memory.peek("k2")).toEqual(planB);
		expect(await shared.get("k2")).toEqual(planB);

		await store.delete("k");
		expect(memory.peek("k")).toBeNull();
		expect(await shared.get("k")).toBeNull();
	});
});
