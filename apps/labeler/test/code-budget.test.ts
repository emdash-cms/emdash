import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createD1ReviewBudget } from "../src/code/budget.js";

const NOW = new Date("2026-11-16T10:00:00.000Z");
const NEXT_DAY = "2026-11-17T00:00:00.000Z";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM code_review_budget").run();
});

describe("D1 review budget", () => {
	it("caps reviews per publisher per UTC day", async () => {
		const budget = createD1ReviewBudget(env.DB, { perPublisherPerDay: 2, totalPerDay: 10 });

		expect(await budget.reserve("did:plc:alice", NOW)).toEqual({ reserved: true });
		expect(await budget.reserve("did:plc:alice", NOW)).toEqual({ reserved: true });
		expect(await budget.reserve("did:plc:alice", NOW)).toEqual({
			reserved: false,
			retryAt: NEXT_DAY,
		});
		expect(await budget.reserve("did:plc:bob", NOW)).toEqual({ reserved: true });
		expect(await budget.reserve("did:plc:alice", new Date(NEXT_DAY))).toEqual({ reserved: true });
	});

	it("caps total reviews without charging the publisher for a refused one", async () => {
		const budget = createD1ReviewBudget(env.DB, { perPublisherPerDay: 5, totalPerDay: 1 });

		expect(await budget.reserve("did:plc:alice", NOW)).toEqual({ reserved: true });
		expect(await budget.reserve("did:plc:bob", NOW)).toEqual({
			reserved: false,
			retryAt: NEXT_DAY,
		});
		const bob = await env.DB.prepare(
			"SELECT count FROM code_review_budget WHERE scope = ? AND window_start = ?",
		)
			.bind("did:plc:bob", "2026-11-16")
			.first<number>("count");
		expect(bob).toBe(0);
	});
});
