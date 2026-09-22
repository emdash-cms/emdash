import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

const AUTHORIZATION = { authorization: "Bearer test-operator-secret" };

describe("operator stale-run recovery", () => {
	test("queues an exact-state retry by issue number once", async () => {
		const issueNumber = 3921;
		const stub = env.Orchestrator.getByName(`issue-${issueNumber}`);
		await stub.event({
			event: "triage",
			arg: null,
			actor: "system",
			labels: [],
			needsClassify: false,
			anchorNumber: issueNumber,
			dryRun: true,
		});
		await stub.debugSetStaleRun("failed-run-3921", Date.now(), "agent-3921", "work");
		await stub.applyAgentResult({
			runId: "failed-run-3921",
			result: { fixed: false, summary: "Candidate publication failed." },
			pushed: false,
			ok: false,
		});
		expect((await stub.getPersistedState()).state).toBe("needs_attention");

		const url = `http://example.com/api/operator/issues/${issueNumber}/command`;
		expect((await SELF.fetch(url, { method: "POST" })).status).toBe(401);
		const mismatch = await SELF.fetch(url, {
			method: "POST",
			headers: { ...AUTHORIZATION, "content-type": "application/json" },
			body: JSON.stringify({
				command: "retry",
				expectedState: "failed",
				idempotencyKey: "drain-3921",
			}),
		});
		expect(mismatch.status).toBe(409);

		const queued = await SELF.fetch(url, {
			method: "POST",
			headers: { ...AUTHORIZATION, "content-type": "application/json" },
			body: JSON.stringify({
				command: "retry",
				expectedState: "needs_attention",
				idempotencyKey: "drain-3921",
			}),
		});
		expect(queued.status).toBe(202);
		expect(await queued.json()).toEqual({ queued: true });
		await expect(stub.inspectRecoveryState()).resolves.toMatchObject({ inboxDepth: 1 });

		const duplicate = await SELF.fetch(url, {
			method: "POST",
			headers: { ...AUTHORIZATION, "content-type": "application/json" },
			body: JSON.stringify({
				command: "retry",
				expectedState: "needs_attention",
				idempotencyKey: "drain-3921",
			}),
		});
		expect(duplicate.status).toBe(409);
		const duplicateBody = (await duplicate.json()) as { queued: boolean; reason: string };
		expect(duplicateBody.queued).toBe(false);
		expect(["command already queued", "state mismatch"]).toContain(duplicateBody.reason);

		await stub.tick();
		await expect(stub.getPersistedState()).resolves.toMatchObject({ state: "working" });
		await expect(stub.inspectRecoveryState()).resolves.toMatchObject({ inboxDepth: 0 });
	});

	test("queues reviewed approval work but rejects the wrong command for that state", async () => {
		const issueNumber = 3922;
		const stub = env.Orchestrator.getByName(`issue-${issueNumber}`);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put({
				"o:anchorNumber": issueNumber,
				"o:state": "awaiting_approval",
				"o:kind": "bug",
			});
		});

		const url = `http://example.com/api/operator/issues/${issueNumber}/command`;
		const rejected = await SELF.fetch(url, {
			method: "POST",
			headers: { ...AUTHORIZATION, "content-type": "application/json" },
			body: JSON.stringify({
				command: "retry",
				expectedState: "awaiting_approval",
				idempotencyKey: "approve-3922",
			}),
		});
		expect(rejected.status).toBe(409);
		expect(await rejected.json()).toEqual({ queued: false, reason: "command not allowed" });

		const queued = await SELF.fetch(url, {
			method: "POST",
			headers: { ...AUTHORIZATION, "content-type": "application/json" },
			body: JSON.stringify({
				command: "work",
				expectedState: "awaiting_approval",
				idempotencyKey: "approve-3922",
			}),
		});
		expect(queued.status).toBe(202);
		expect(await queued.json()).toEqual({ queued: true });

		await stub.tick();
		await expect(stub.getPersistedState()).resolves.toMatchObject({ state: "working" });
		await expect(stub.inspectRecoveryState()).resolves.toMatchObject({ inboxDepth: 0 });
	});

	test("terminal missing-anchor cleanup clears every retryable projection and alarm", async () => {
		const stub = env.Orchestrator.getByName("operator-missing-anchor");
		await stub.debugSetStaleRun(
			"stale-run-3123",
			Date.now() - 60 * 60_000,
			"agent-3123",
			"implement",
		);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put({
				"o:anchorNumber": 3123,
				"o:inbox": [{ id: "delivery", input: {} }],
				"o:pendingSideEffects": [{ id: "effect" }],
				"o:workComments": [{ runId: "stale-run-3123", pending: true }],
				"o:prPollNextAt": Date.now(),
			});
			await state.storage.setAlarm(Date.now() + 1_000);
		});

		await stub.debugTerminalizeMissingAnchor(3123);
		await expect(stub.inspectRecoveryState()).resolves.toMatchObject({
			anchorNumber: 3123,
			currentRunId: null,
			inboxDepth: 0,
			pendingSideEffects: 0,
			pendingWorkComments: 0,
			terminal: { anchorNumber: 3123, runId: "stale-run-3123", reason: "missing-anchor" },
			alarmAt: null,
		});
	});

	test("inspects first and settles only an exact anchor and run match", async () => {
		const id = env.Orchestrator.idFromName("operator-live-issue");
		const stub = env.Orchestrator.get(id);
		await stub.debugSetStaleRun(
			"stale-run-2693",
			Date.now() - 60 * 60_000,
			"agent-2693",
			"implement",
		);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put({
				"o:anchorNumber": 2693,
				"o:state": "working",
				"o:kind": "bug",
				"o:pendingSideEffects": [{ id: "final-effect", runId: "stale-run-2693", settlesRun: true }],
			});
		});
		const base = `http://example.com/api/operator/orchestrators/${id.toString()}/recovery`;

		expect((await SELF.fetch(base)).status).toBe(401);
		const inspected = await SELF.fetch(base, { headers: AUTHORIZATION });
		expect(inspected.status).toBe(200);
		await expect(inspected.json()).resolves.toMatchObject({
			anchorNumber: 2693,
			currentRunId: "stale-run-2693",
		});

		const mismatch = await SELF.fetch(`${base}/settle`, {
			method: "POST",
			headers: { ...AUTHORIZATION, "content-type": "application/json" },
			body: JSON.stringify({ expectedAnchorNumber: 2693, expectedRunId: "different-run" }),
		});
		expect(mismatch.status).toBe(409);
		expect((await stub.getPersistedState()).currentRunId).toBe("stale-run-2693");

		const settled = await SELF.fetch(`${base}/settle`, {
			method: "POST",
			headers: { ...AUTHORIZATION, "content-type": "application/json" },
			body: JSON.stringify({ expectedAnchorNumber: 2693, expectedRunId: "stale-run-2693" }),
		});
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ settled: true });
		expect(await stub.getPersistedState()).toMatchObject({ state: "working", currentRunId: null });
		expect(await stub.getPendingSideEffectCount()).toBe(0);
	});
});
