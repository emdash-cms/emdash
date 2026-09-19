import {
	env,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";

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

	test("grants a post-reset lease only to the exact orchestrator operation", async () => {
		const stub = env.GITHUB_RATE_LIMIT.getByName("installation:lease-isolation");
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put("installation-rate-limit", {
				backoffUntil: Date.now() - 1,
				nextPermitAt: Date.now() - 1,
				releaseUntil: Date.now() + 30_000,
				limit: 5_000,
				remaining: 5_000,
				resetAt: Date.now() + 60 * 60_000,
			});
		});

		expect(await stub.permit("issue:get", "orchestrator:2693")).toMatchObject({
			allowed: true,
		});
		expect(await stub.permit("issue:get", "orchestrator:2693")).toMatchObject({
			allowed: true,
		});
		expect(await stub.permit("issue:get", "orchestrator:3215")).toMatchObject({
			allowed: false,
		});

		const sandbox = env.GITHUB_RATE_LIMIT.getByName("installation:sandbox-no-shared-lease");
		await runInDurableObject(sandbox, async (_instance, state) => {
			await state.storage.put("installation-rate-limit", {
				backoffUntil: Date.now() - 1,
				nextPermitAt: Date.now() - 1,
				releaseUntil: Date.now() + 30_000,
				limit: 5_000,
				remaining: 5_000,
				resetAt: Date.now() + 60 * 60_000,
			});
		});
		expect(await sandbox.permit("sandbox-git", "sandbox-outbound")).toMatchObject({
			allowed: true,
		});
		expect(await sandbox.permit("sandbox-git", "sandbox-outbound")).toMatchObject({
			allowed: false,
		});
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

describe("orchestrator alarm recovery", () => {
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
