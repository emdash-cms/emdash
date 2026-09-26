import {
	env,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";

describe("GitHub installation coordination", () => {
	test("persists the later reset across eviction and suppresses every caller", async () => {
		const now = Date.now();
		const first = env.GITHUB_RATE_LIMIT.getByName("installation:shared-reset");
		await first.record("issue:get", "orchestrator-a", {
			status: 403,
			limit: 5_000,
			remaining: 0,
			resetAt: now + 120_000,
			retryAfterAt: now + 60_000,
		});

		const initial = await first.permit("issue-label:get", "orchestrator-b");
		expect(initial).toEqual({ allowed: false, retryAt: expect.any(Number) });
		expect(initial.retryAt).toBeGreaterThanOrEqual(now + 120_000);

		await evictDurableObject(first);
		const afterEviction = await env.GITHUB_RATE_LIMIT.getByName("installation:shared-reset").permit(
			"graphql",
			"emdash-flue-review",
		);
		expect(afterEviction.allowed).toBe(false);
		expect(afterEviction.retryAt).toBe(initial.retryAt);
	});

	test("adds bounded release jitter only after the reset boundary", async () => {
		const now = Date.now();
		const stub = env.GITHUB_RATE_LIMIT.getByName("installation:jitter");
		await stub.record("graphql", "orchestrator", {
			status: 429,
			limit: 5_000,
			remaining: 0,
			resetAt: now + 30_000,
			retryAfterAt: null,
		});
		const state = await stub.inspect();
		expect(state).not.toBeNull();
		expect(state?.nextPermitAt).toBeGreaterThanOrEqual(state?.backoffUntil ?? 0);
		expect((state?.nextPermitAt ?? 0) - (state?.backoffUntil ?? 0)).toBeLessThanOrEqual(5_000);
	});

	test("reserves every successful permit and does not let one consumer burst", async () => {
		const stub = env.GITHUB_RATE_LIMIT.getByName("installation:permit-reservation");
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put("installation-rate-limit", {
				backoffUntil: 0,
				nextPermitAt: Date.now() - 1,
				limit: 5_000,
				remaining: 5_000,
				resetAt: Date.now() + 60 * 60_000,
			});
		});

		expect(await stub.permit("issue:get", "orchestrator:2693")).toMatchObject({
			allowed: true,
		});
		const sameConsumer = await stub.permit("issue:get", "orchestrator:2693");
		const otherConsumer = await stub.permit("issue:get", "orchestrator:3215");
		expect(sameConsumer).toMatchObject({
			allowed: false,
		});
		expect(otherConsumer).toEqual(sameConsumer);
		expect(await stub.inspect()).toMatchObject({
			remaining: 4_999,
			nextPermitAt: sameConsumer.retryAt,
		});
	});

	test("paces from successful response headers before GitHub rejects a request", async () => {
		const stub = env.GITHUB_RATE_LIMIT.getByName("installation:proactive-pacing");
		const now = Date.now();
		await stub.record("graphql", "orchestrator", {
			status: 200,
			limit: 5_000,
			remaining: 100,
			resetAt: now + 60_000,
			retryAfterAt: null,
		});

		const permit = await stub.permit("issue:get", "another-orchestrator");
		expect(permit.allowed).toBe(false);
		expect(permit.retryAt).toBeGreaterThanOrEqual(now + 600);
	});

	test("suppresses label reconciliation in another orchestrator during shared backoff", async () => {
		const testEnv = env;
		testEnv.GITHUB_APP_PRIVATE_KEY = "configured-for-cached-token";
		const coordinator = testEnv.GITHUB_RATE_LIMIT.getByName(
			`installation:${testEnv.GITHUB_APP_INSTALLATION_ID}`,
		);
		await coordinator.record("graphql", "orchestrator-a", {
			status: 429,
			limit: 5_000,
			remaining: 0,
			resetAt: Date.now() + 60_000,
			retryAfterAt: null,
		});
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const stub = testEnv.Orchestrator.getByName("issue-label-backoff");
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60_000);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put({
				"o:anchorNumber": 42,
				"o:state": "working",
				"o:kind": "bug",
				"o:pendingSideEffects": [
					{
						id: "blocked-effect",
						settlesRun: false,
						anchorNumber: 42,
						addLabels: ["bot:working"],
						removeLabels: [],
						commentBody: "",
						commentMarker: "<!-- blocked -->",
						commentMayExist: false,
					},
				],
			});
		});

		const tick = await stub.tick();
		expect(tick.labelDrift).toBeNull();
		expect(tick.inboxError).toContain("suppressed until");
		expect(fetchMock).not.toHaveBeenCalled();
		await expect(stub.inspectRecoveryState()).resolves.toMatchObject({
			retry: null,
			terminal: null,
		});
		vi.unstubAllGlobals();
		testEnv.GITHUB_APP_PRIVATE_KEY = "";
	});
});

describe("dashboard reconciliation", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("schedules another reconciliation after a successful refresh", async () => {
		const dashboard = env.DASHBOARD.getByName("repo:emdash-cms/emdash-reconcile-test");
		const gate = env.GITHUB_RATE_LIMIT.getByName(`installation:${env.GITHUB_APP_INSTALLATION_ID}`);
		await runInDurableObject(gate, async (_instance, state) => {
			await state.storage.delete("installation-rate-limit");
		});
		await gate.debugSetInstallationToken("cached-token", Date.now() + 60 * 60_000);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json([]))),
		);

		await runInDurableObject(dashboard, async (_instance, state) => {
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		expect(await runDurableObjectAlarm(dashboard)).toBe(true);
		await runInDurableObject(dashboard, async (_instance, state) => {
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now() + 4 * 60_000);
			await state.storage.deleteAlarm();
		});
		await runInDurableObject(gate, async (_instance, state) => {
			await state.storage.delete("installation-rate-limit");
		});
	});
});

describe("orchestrator alarm recovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("cleans up an idle orchestrator instead of rearming label reconciliation", async () => {
		const stub = env.Orchestrator.getByName(`issue-idle-${crypto.randomUUID()}`);
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put({
				"o:anchorNumber": 42,
				"o:state": "needs_attention",
				"o:kind": "bug",
				"o:prNumber": 99,
				"o:labelReconcileNextAt": Date.now() - 1_000,
			});
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.getAlarm()).toBeNull();
			expect(await state.storage.get("o:labelReconcileNextAt")).toBeUndefined();
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining('"message":"orchestrator self-cleanup completed"'),
		);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('"anchorNumber":42'));
	});

	test("sleeps until reporter expiry without periodic label reconciliation", async () => {
		const stub = env.Orchestrator.getByName(`issue-reporter-${crypto.randomUUID()}`);
		const now = Date.now();
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put({
				"o:anchorNumber": 42,
				"o:state": "awaiting_reporter",
				"o:kind": "bug",
				"o:awaitingReporterSince": now,
				"o:labelReconcileNextAt": now + 15 * 60_000,
			});
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.getAlarm()).toBeGreaterThan(now + 13 * 24 * 60 * 60_000);
			expect(await state.storage.get("o:labelReconcileNextAt")).toBeUndefined();
		});
	});

	test("cleans up terminal state even when stale retries remain", async () => {
		const stub = env.Orchestrator.getByName(`issue-terminal-${crypto.randomUUID()}`);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put({
				"o:anchorNumber": 42,
				"o:state": "done",
				"o:publicationRetryAt": Date.now() + 60 * 60_000,
				"o:recoveryRetry": {
					path: "publication",
					attempts: 1,
					nextAt: Date.now() + 60 * 60_000,
				},
			});
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await expect(stub.inspectRecoveryState()).resolves.toMatchObject({
			retry: null,
			alarmAt: null,
		});
	});

	test("persists exponential recovery instead of rearming an overdue stale run every second", async () => {
		const stub = env.Orchestrator.getByName("issue-alarm-backoff");
		await stub.debugSetStaleRun(
			"stale-run",
			Date.now() - 24 * 60 * 60_000,
			"abort-false-agent",
			"implement",
		);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const first = await stub.inspectRecoveryState();
		expect(first.retry).toMatchObject({ path: "stale-run", attempts: 1 });
		expect(first.retry?.nextAt).toBeGreaterThanOrEqual(Date.now() + 55_000);
		expect(first.alarmAt).toBeGreaterThanOrEqual(first.retry?.nextAt ?? 0);
	});

	test("exhausts bounded stale recovery into an operator-visible terminal state", async () => {
		const stub = env.Orchestrator.getByName("issue-recovery-exhaustion");
		await stub.debugSetStaleRun(
			"stale-run",
			Date.now() - 24 * 60 * 60_000,
			"abort-false-agent",
			"implement",
		);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		for (let attempt = 0; attempt < 8; attempt += 1) {
			expect(await runDurableObjectAlarm(stub)).toBe(true);
		}
		await expect(stub.inspectRecoveryState()).resolves.toMatchObject({
			terminal: { path: "stale-run", attempts: 8, errorKind: "recovery-error" },
			alarmAt: null,
		});
	});

	test("counts alternating recovery paths toward the same bounded exhaustion", async () => {
		const stub = env.Orchestrator.getByName("issue-alternating-recovery-exhaustion");
		for (let attempt = 0; attempt < 8; attempt += 1) {
			await stub.debugRecordRecoveryFailure(attempt % 2 === 0 ? "work-comment" : "labels");
		}
		await expect(stub.inspectRecoveryState()).resolves.toMatchObject({
			terminal: { path: "labels", attempts: 8, errorKind: "recovery-error" },
			alarmAt: null,
		});
	});
});
