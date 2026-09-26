import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { isIssuancePaused, setIssuancePaused } from "../src/issuance-control.js";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("issuance control", () => {
	it("does not let an old idempotent pause retry reverse a newer resume", async () => {
		const common = {
			db: env.DB,
			actorDid: "did:web:labels.example:operators:admin",
			role: "admin" as const,
		};
		await setIssuancePaused({
			...common,
			paused: true,
			reason: "Pause while investigating publication",
			idempotencyKey: "issuance-pause-old-001",
			now: new Date("2026-08-25T10:00:00.000Z"),
		});
		await setIssuancePaused({
			...common,
			paused: false,
			reason: "Resume after investigation",
			idempotencyKey: "issuance-resume-new-001",
			now: new Date("2026-08-25T10:01:00.000Z"),
		});

		const replay = await setIssuancePaused({
			...common,
			paused: true,
			reason: "Pause while investigating publication",
			idempotencyKey: "issuance-pause-old-001",
			now: new Date("2026-08-25T10:02:00.000Z"),
		});

		expect(replay).toEqual({ paused: false });
		expect(await isIssuancePaused(env.DB)).toBe(false);
		expect(
			await env.DB.prepare(
				"SELECT value, updated_at FROM service_state WHERE key = 'issuance_paused'",
			).first(),
		).toEqual({ value: "0", updated_at: "2026-08-25T10:01:00.000Z" });
	});
});
