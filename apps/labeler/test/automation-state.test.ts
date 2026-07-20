import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
	AutomationStateUnavailableError,
	buildAutomationPauseUpdate,
	isAutomationPaused,
} from "../src/automation-state.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const NOW = new Date("2026-07-13T00:00:00.000Z");
const ACTION_ID = "oact_automationtest";

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	await insertOperatorAction(ACTION_ID);
});

afterEach(async () => {
	await buildAutomationPauseUpdate(testEnv.DB, {
		paused: false,
		reason: null,
		actionId: ACTION_ID,
		now: NOW,
	}).run();
});

/** Seeds an `operator_actions` row so pause/resume FK references resolve. */
async function insertOperatorAction(id: string): Promise<void> {
	await testEnv.DB.prepare(
		`INSERT INTO operator_actions
		 (id, actor_type, actor_id, role, action, reason, idempotency_key,
		  request_fingerprint, created_at, created_at_epoch_ms)
		 VALUES (?, 'human', 'u', 'admin', 'pause-issuance', 'r', ?, 'fp',
		         '2026-07-13T00:00:00.000Z', 0)`,
	)
		.bind(id, `key-${id}`)
		.run();
}

describe("isAutomationPaused", () => {
	it("reads false for the seeded (unpaused) singleton row", async () => {
		expect(await isAutomationPaused(testEnv.DB)).toBe(false);
	});

	it("round-trips a pause and a resume through the update builder", async () => {
		await buildAutomationPauseUpdate(testEnv.DB, {
			paused: true,
			reason: "incident-42",
			actionId: ACTION_ID,
			now: NOW,
		}).run();
		expect(await isAutomationPaused(testEnv.DB)).toBe(true);

		const paused = await testEnv.DB.prepare(
			`SELECT paused, paused_reason, paused_by_action_id FROM automation_state WHERE id = 1`,
		).first<{ paused: number; paused_reason: string; paused_by_action_id: string }>();
		expect(paused).toEqual({
			paused: 1,
			paused_reason: "incident-42",
			paused_by_action_id: ACTION_ID,
		});

		await buildAutomationPauseUpdate(testEnv.DB, {
			paused: false,
			reason: null,
			actionId: ACTION_ID,
			now: NOW,
		}).run();
		expect(await isAutomationPaused(testEnv.DB)).toBe(false);
	});

	it("fails closed when the singleton row is missing", async () => {
		await testEnv.DB.prepare(`DELETE FROM automation_state WHERE id = 1`).run();
		try {
			await expect(isAutomationPaused(testEnv.DB)).rejects.toBeInstanceOf(
				AutomationStateUnavailableError,
			);
		} finally {
			await testEnv.DB.prepare(
				`INSERT INTO automation_state (id, paused, updated_at, updated_at_epoch_ms)
				 VALUES (1, 0, '1970-01-01T00:00:00.000Z', 0)`,
			).run();
		}
	});

	it("fails closed when the read throws", async () => {
		const brokenDb = {
			prepare() {
				return {
					bind() {
						return this;
					},
					first(): Promise<never> {
						return Promise.reject(new Error("D1_ERROR: connection lost"));
					},
				};
			},
		} as unknown as D1Database;

		await expect(isAutomationPaused(brokenDb)).rejects.toBeInstanceOf(
			AutomationStateUnavailableError,
		);
	});
});
