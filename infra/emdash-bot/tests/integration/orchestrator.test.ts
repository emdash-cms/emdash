// Workers-pool integration tests for OrchestratorDO.
//
// These run inside a real workerd isolate via @cloudflare/vitest-pool-workers,
// so `env.Orchestrator` is the actual DO namespace, storage is real (sqlite
// inside miniflare), and lifecycle semantics (single-threaded per instance,
// blockConcurrencyWhile, etc.) match production.
//
// Coverage here is intentionally narrow: the pure router logic has its own
// suite (tests/unit/router.test.ts). What we verify here is the DO wiring:
//   - new instance starts in unmanaged
//   - event() persists state on transition
//   - event log records the transition with the right shape
//   - duplicate deliveryId is deduped
//   - stale runId in applyAgentResult is silently dropped
//   - inert state ignores agent results
//
// Each test uses a fresh DO instance via `getByName(uniqueName)` so test
// ordering doesn't matter.

import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import type { NormalizedEvent } from "../../.flue/lib/orchestrator.js";

interface TestEnv {
	Orchestrator: Env["Orchestrator"];
}

const testEnv = env as unknown as TestEnv;

function uniqueIssueName(): string {
	// `crypto.randomUUID()` is available in workerd. Using it keeps test
	// isolation hermetic without relying on a per-test counter.
	return `issue-${crypto.randomUUID()}`;
}

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
	return {
		event: "implement",
		arg: "add dark mode",
		actor: "maintainer",
		labels: [],
		needsClassify: false,
		dryRun: true,
		...overrides,
	};
}

describe("OrchestratorDO (workers-pool)", () => {
	test("fresh instance starts with no persisted state", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const state = await stub.getPersistedState();
		expect(state).toEqual({
			state: null,
			kind: null,
			currentRunId: null,
			currentAgentId: null,
			currentDispatchId: null,
			prNumber: null,
		});
		expect(await stub.getEventLog()).toEqual([]);
	});

	test("event() persists the resolved state on a valid transition", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const outcome = await stub.event(makeEvent());
		expect(outcome.kind).toBe("transition");

		const persisted = await stub.getPersistedState();
		expect(persisted.state).toBe("working");
		// `implement` from unmanaged is an entry transition with default kind.
		// machine.ts's implement event sets defaultKind: "enhancement"
		// (verified separately in router tests).
		expect(persisted.kind).toBe("enhancement");
	});

	test("event() appends an entry to the event log", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ deliveryId: "delivery-abc" }));
		const log = await stub.getEventLog();
		expect(log.length).toBe(1);
		const entry = log[0];
		expect(entry).toBeDefined();
		if (!entry) return;
		expect(entry.event).toBe("implement");
		expect(entry.actor).toBe("maintainer");
		expect(entry.from).toBe("unmanaged");
		expect(entry.to).toBe("working");
		expect(entry.deliveryId).toBe("delivery-abc");
		expect(typeof entry.t).toBe("number");
	});

	test("duplicate deliveryId is deduped on the second event() call", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const first = await stub.event(makeEvent({ deliveryId: "dup-1" }));
		expect(first.kind).toBe("transition");

		const second = await stub.event(makeEvent({ deliveryId: "dup-1" }));
		expect(second.kind).toBe("duplicate");

		// State should reflect only the first transition.
		const log = await stub.getEventLog();
		expect(log.length).toBe(1);
	});

	test("noop event() does not advance state", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		// `confirm` from unmanaged has no transition (router resolves to noop).
		const outcome = await stub.event(
			makeEvent({ event: "confirm", arg: null, actor: "maintainer" }),
		);
		expect(outcome.kind).toBe("noop");
		const persisted = await stub.getPersistedState();
		expect(persisted.state).toBe(null);
	});

	test("applyAgentResult drops stale runId silently", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		// No currentRunId persisted; any runId is therefore stale.
		const outcome = await stub.applyAgentResult({
			runId: "ghost-run",
			result: { reproduced: true, fixed: true },
			pushed: true,
			ok: true,
		});
		expect(outcome.kind).toBe("stale-run");
		if (outcome.kind === "stale-run") {
			expect(outcome.runId).toBe("ghost-run");
			expect(outcome.currentRunId).toBe(null);
		}
	});

	test("applyAgentResult commits the transition before clearing run markers", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent());
		await stub.debugSetStaleRun("active-run", Date.now());

		const outcome = await stub.applyAgentResult({
			runId: "active-run",
			result: { reproduced: true, fixed: false, summary: "The issue reproduces." },
			pushed: false,
			ok: true,
		});
		expect(outcome.kind).toBe("transition");

		const persisted = await stub.getPersistedState();
		expect(persisted.state).not.toBe("working");
		expect(persisted.currentRunId).toBe(null);
		expect(persisted.currentAgentId).toBe(null);
		expect(persisted.currentDispatchId).toBe(null);
	});

	test("an implement run can advance to fix ready without a reproduced result", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent());
		await stub.debugSetStaleRun("implement-run", Date.now(), undefined, "implement");

		const outcome = await stub.applyAgentResult({
			runId: "implement-run",
			result: { fixed: true, summary: "Implemented the requested change." },
			pushed: true,
			ok: true,
		});

		expect(outcome.kind).toBe("transition");
		expect((await stub.getPersistedState()).state).toBe("awaiting_feedback");
	});

	test("tick recovers a stale run", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		// Run() the DO with a synthetic stale run set in storage. The stale-
		// run recovery path only inspects the started-at timestamp; we drive
		// it through the public RPC.
		await stub.event(makeEvent({ anchorNumber: 999 }));

		// Inject a stale run via a helper we expose for tests.
		await stub.debugSetStaleRun(
			"ghost-run",
			Date.now() - 60 * 60 * 1000,
			"investigate-999-ghost-run",
		);

		const outcome = await stub.tick();
		expect(outcome.droppedStaleRun).toBe(true);

		const persisted = await stub.getPersistedState();
		expect(persisted.currentRunId).toBe(null);
		expect(persisted.state).toBe("failed");
	});

	test("a failing inbox head does not block stale-run recovery", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ anchorNumber: 999 }));
		await stub.enqueue(
			makeEvent({
				event: null,
				needsClassify: true,
				classifyText: "please investigate this",
				deliveryId: "classifier-failure",
				anchorNumber: 999,
			}),
		);
		await stub.debugSetStaleRun(
			"stale-run",
			Date.now() - 60 * 60 * 1000,
			"investigate-999-stale-run",
		);

		const outcome = await stub.tick();
		expect(outcome.inboxError).toMatch(/classifier failed/);
		expect((await stub.getPersistedState()).state).toBe("failed");
		expect(await stub.getInboxDepth()).toBe(1);
	});

	test("dead-letters a persistently failing classifier entry", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.enqueue(
			makeEvent({
				event: null,
				needsClassify: true,
				classifyText: "please investigate this",
				deliveryId: "poison-classifier-entry",
				anchorNumber: 999,
			}),
		);
		await stub.enqueue(
			makeEvent({
				event: "confirm",
				arg: null,
				deliveryId: "later-valid-entry",
			}),
		);

		for (let attempt = 0; attempt < 3; attempt += 1) await stub.tick();
		expect(await stub.getInboxDepth()).toBe(0);
	});

	test("drains a bounded batch of successful inbox entries per tick", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.enqueue(makeEvent({ event: "confirm", arg: null, deliveryId: "batch-entry-1" }));
		await stub.enqueue(makeEvent({ event: "confirm", arg: null, deliveryId: "batch-entry-2" }));

		await stub.tick();

		expect(await stub.getInboxDepth()).toBe(0);
	});

	test("failed abort retains stale-run markers", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ anchorNumber: 999 }));
		await stub.debugSetStaleRun(
			"stale-run",
			Date.now() - 60 * 60 * 1000,
			"investigate-999-abort-false",
		);

		const outcome = await stub.tick();
		expect(outcome.droppedStaleRun).toBe(false);
		expect(outcome.recoveryError).toMatch(/did not settle/);
		expect((await stub.getPersistedState()).currentRunId).toBe("stale-run");
	});

	test("a definitive dispatch rejection fails the run and consumes its delivery", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.enqueue(makeEvent({ deliveryId: "rejected-dispatch", anchorNumber: 999 }));
		await stub.debugSetPendingDispatch({
			runId: "rejected-run",
			agentId: "investigate-999-rejected-run",
			deliveryId: "rejected-dispatch",
			startedAt: Date.now(),
			dispatchError: "admission rejected",
		});

		await stub.tick();

		const persisted = await stub.getPersistedState();
		expect(persisted.state).toBe("failed");
		expect(persisted.currentRunId).toBeNull();
		expect(await stub.getInboxDepth()).toBe(0);
	});

	test("stale recovery fails a dispatch that never admitted an agent", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.enqueue(makeEvent({ deliveryId: "missing-dispatch", anchorNumber: 999 }));
		await stub.debugSetPendingDispatch({
			runId: "missing-run",
			agentId: "investigate-999-abort-false-missing",
			deliveryId: "missing-dispatch",
			startedAt: Date.now() - 60 * 60 * 1000,
			dispatchAttempt: "uncertain-attempt",
		});

		await stub.tick();

		const persisted = await stub.getPersistedState();
		expect(persisted.state).toBe("failed");
		expect(persisted.currentRunId).toBeNull();
		await stub.tick();
		expect(await stub.getInboxDepth()).toBe(0);
	});

	test("dryRun readonly status does not enqueue a GitHub side effect", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const outcome = await stub.event(
			makeEvent({
				event: "status",
				arg: null,
				actor: "maintainer",
				dryRun: true,
				anchorNumber: 42,
				deliveryId: "dry-status-1",
			}),
		);
		expect(outcome.kind).toBe("readonly");
		expect(await stub.getPendingSideEffectCount()).toBe(0);
	});

	test("concurrent events on the same DO yield a deterministic end state", async () => {
		// workerd single-threads DO message processing; this test pins that
		// two events fired in parallel observe each other's effects rather
		// than racing on storage. We dispatch `implement` (a real transition)
		// alongside `status` (readonly) and assert the final persisted state
		// matches the implement transition and the log contains exactly one
		// entry -- proving the readonly didn't get serialized as a phantom
		// log row and the implement's storage write wasn't lost to a race.
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await Promise.all([
			stub.event(makeEvent({ deliveryId: "seq-1" })),
			stub.event(makeEvent({ deliveryId: "seq-2", event: "status", actor: "maintainer" })),
		]);

		const persisted = await stub.getPersistedState();
		expect(persisted.state).toBe("working");
		const log = await stub.getEventLog();
		expect(log.length).toBe(1);
	});
});
