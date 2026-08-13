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
import { afterEach, describe, expect, test, vi } from "vitest";

import { applyInvestigationResult } from "../../.flue/lib/investigation-result.js";
import type { NormalizedEvent } from "../../.flue/lib/orchestrator.js";

interface TestEnv {
	Orchestrator: Env["Orchestrator"];
	GITHUB_APP_PRIVATE_KEY: string;
	PREVIEW_PACKAGE: string;
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

function parseJsonBody(body: unknown): unknown {
	if (typeof body !== "string") throw new Error("expected a string request body");
	return JSON.parse(body);
}

describe("OrchestratorDO (workers-pool)", () => {
	// The credential-injecting tests below mutate shared env and global fetch;
	// reset both after every test so nothing leaks into a later case.
	afterEach(() => {
		testEnv.GITHUB_APP_PRIVATE_KEY = "";
		testEnv.PREVIEW_PACKAGE = "emdash";
		vi.unstubAllGlobals();
	});

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
		expect(persisted.state).toBe("fixing");
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
		expect(entry.to).toBe("fixing");
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

	test("investigation result handoff returns a durable step value", async () => {
		await expect(
			applyInvestigationResult(
				{ issueNumber: 987_654_321, runId: "ghost-run" },
				{ summary: "The investigation completed." },
				true,
				false,
			),
		).resolves.toBe(true);
	});

	test("applyAgentResult commits the transition before clearing run markers", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent());
		await stub.debugSetStaleRun("active-run", Date.now(), undefined, "implement");

		const outcome = await stub.applyAgentResult({
			runId: "active-run",
			result: { implemented: true, summary: "Implemented the requested change." },
			pushed: true,
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
			result: { implemented: true, summary: "Implemented the requested change." },
			pushed: true,
			ok: true,
		});

		expect(outcome.kind).toBe("transition");
		expect((await stub.getPersistedState()).state).toBe("preview_building");
	});

	test("a rejected implementation returns to a state where implement can be retried", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent());
		await stub.debugSetStaleRun("implement-run", Date.now(), undefined, "implement");
		await stub.applyAgentResult({
			runId: "implement-run",
			result: { implemented: true, summary: "Implemented the requested change." },
			pushed: true,
			ok: true,
		});
		await stub.event(
			makeEvent({ event: "preview.ready", arg: null, actor: "system", anchorNumber: 42 }),
		);

		const rejected = await stub.event(
			makeEvent({ event: "reject", arg: "needs revision", actor: "reporter", anchorNumber: 42 }),
		);

		expect(rejected.kind).toBe("transition");
		expect((await stub.getPersistedState()).state).toBe("blocked");
		const retry = await stub.event(
			makeEvent({ event: "implement", arg: "apply the feedback", anchorNumber: 42 }),
		);
		expect(retry.kind).toBe("transition");
		if (retry.kind === "transition") expect(retry.decision.action).toBe("investigate.implement");
	});

	test("a failed run comment carries its stage and durable run id", async () => {
		const calls: string[] = [];
		const comments: string[] = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", githubCallRecorder(calls, 201, comments));
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await stub.debugPrimeFixing(42);
		await stub.debugSetStaleRun(
			"implement-run-123",
			Date.now(),
			"investigate-42-implement-run-123",
			"implement",
		);

		await stub.applyAgentResult({
			runId: "implement-run-123",
			result: {
				implemented: false,
				failureStage: "verification",
				summary: "The required typecheck failed.",
			},
			pushed: false,
			ok: true,
		});

		expect((await stub.getPersistedState()).state).toBe("failed");
		expect(comments.at(-1)).toContain("Failed stage: `verification`");
		expect(comments.at(-1)).toContain("Run: `implement-run-123`");
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

	test("investigate is rejected for a non-maintainer actor", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const outcome = await stub.event(
			makeEvent({
				event: "investigate",
				arg: "look at the loader",
				actor: "reporter",
				anchorNumber: 42,
			}),
		);
		expect(outcome.kind).toBe("noop");
		expect((await stub.getPersistedState()).state).toBe(null);
	});

	test("a diagnose run blocked on reporter info lands on needs_info", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ event: "investigate", arg: "diagnose it", anchorNumber: 42 }));
		expect((await stub.getPersistedState()).state).toBe("investigating");

		await stub.debugSetStaleRun("diag-run", Date.now(), "investigate-42-diag-run", "diagnose");
		const outcome = await stub.applyAgentResult({
			runId: "diag-run",
			result: { verdict: "unclear", summary: "I need the exact steps that fail for you." },
			pushed: false,
			ok: true,
		});
		expect(outcome.kind).toBe("transition");
		expect((await stub.getPersistedState()).state).toBe("needs_info");
	});

	test("the fix loop runs from a diagnosis to a confirmed draft PR", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ event: "investigate", arg: "diagnose it", anchorNumber: 42 }));

		await stub.debugSetStaleRun("diag-run", Date.now(), "investigate-42-diag-run", "diagnose");
		await stub.applyAgentResult({
			runId: "diag-run",
			result: { reproduced: true, summary: "Reproduced: the loader drops the locale." },
			pushed: false,
			ok: true,
		});
		expect((await stub.getPersistedState()).state).toBe("reproduced");

		await stub.event(makeEvent({ event: "fix", arg: "fix the loader", anchorNumber: 42 }));
		expect((await stub.getPersistedState()).state).toBe("fixing");

		await stub.debugSetStaleRun("fix-run", Date.now(), "investigate-42-fix-run", "fix");
		await stub.applyAgentResult({
			runId: "fix-run",
			result: { fixed: true, summary: "Fixed the loader; added a test." },
			pushed: true,
			ok: true,
		});
		expect((await stub.getPersistedState()).state).toBe("preview_building");

		await stub.event(
			makeEvent({ event: "preview.ready", arg: null, actor: "system", anchorNumber: 42 }),
		);
		expect((await stub.getPersistedState()).state).toBe("awaiting_reporter");

		const confirm = await stub.event(
			makeEvent({ event: "confirm", arg: null, actor: "reporter", anchorNumber: 42 }),
		);
		expect(confirm.kind).toBe("transition");
		if (confirm.kind === "transition") expect(confirm.decision.action).toBe("openDraftPr");
		expect((await stub.getPersistedState()).state).toBe("in_review");
	});

	test("a reporter rejection reaps the branch back to the reproduced verdict", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ event: "investigate", arg: "diagnose it", anchorNumber: 42 }));
		await stub.debugSetStaleRun("diag-run", Date.now(), "investigate-42-diag-run", "diagnose");
		await stub.applyAgentResult({
			runId: "diag-run",
			result: { reproduced: true, summary: "Reproduced it." },
			pushed: false,
			ok: true,
		});
		await stub.event(makeEvent({ event: "fix", arg: "fix it", anchorNumber: 42 }));
		await stub.debugSetStaleRun("fix-run", Date.now(), "investigate-42-fix-run", "fix");
		await stub.applyAgentResult({
			runId: "fix-run",
			result: { fixed: true, summary: "Built a candidate." },
			pushed: true,
			ok: true,
		});
		await stub.event(
			makeEvent({ event: "preview.ready", arg: null, actor: "system", anchorNumber: 42 }),
		);
		expect((await stub.getPersistedState()).state).toBe("awaiting_reporter");

		const reject = await stub.event(
			makeEvent({
				event: "reject",
				arg: "still broken on my end",
				actor: "reporter",
				anchorNumber: 42,
			}),
		);
		expect(reject.kind).toBe("transition");
		if (reject.kind === "transition") expect(reject.decision.action).toBe("reapBranch");
		expect((await stub.getPersistedState()).state).toBe("reproduced");
	});

	test("a fix run that reports skipped rests in blocked, not wedged in fixing", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ event: "investigate", arg: "diagnose it", anchorNumber: 42 }));
		await stub.debugSetStaleRun("diag-run", Date.now(), "investigate-42-diag-run", "diagnose");
		await stub.applyAgentResult({
			runId: "diag-run",
			result: { reproduced: true, summary: "Reproduced it." },
			pushed: false,
			ok: true,
		});
		await stub.event(makeEvent({ event: "fix", arg: "fix it", anchorNumber: 42 }));
		expect((await stub.getPersistedState()).state).toBe("fixing");

		await stub.debugSetStaleRun("fix-run", Date.now(), "investigate-42-fix-run", "fix");
		const outcome = await stub.applyAgentResult({
			runId: "fix-run",
			result: { skipped: true, summary: "This needs a product decision, not a code fix." },
			pushed: false,
			ok: true,
		});
		expect(outcome.kind).toBe("transition");
		expect((await stub.getPersistedState()).state).toBe("blocked");
	});

	test("reporter silence past the window expires the wait and reaps the branch", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ event: "investigate", arg: "diagnose it", anchorNumber: 42 }));
		await stub.debugSetStaleRun("diag-run", Date.now(), "investigate-42-diag-run", "diagnose");
		await stub.applyAgentResult({
			runId: "diag-run",
			result: { reproduced: true, summary: "Reproduced it." },
			pushed: false,
			ok: true,
		});
		await stub.event(makeEvent({ event: "fix", arg: "fix it", anchorNumber: 42 }));
		await stub.debugSetStaleRun("fix-run", Date.now(), "investigate-42-fix-run", "fix");
		await stub.applyAgentResult({
			runId: "fix-run",
			result: { fixed: true, summary: "Built a candidate." },
			pushed: true,
			ok: true,
		});
		await stub.event(
			makeEvent({ event: "preview.ready", arg: null, actor: "system", anchorNumber: 42 }),
		);
		expect((await stub.getPersistedState()).state).toBe("awaiting_reporter");

		// Backdate the confirmation window past 14 days, then run the alarm.
		await stub.debugBackdateReporterWait(Date.now() - 15 * 24 * 60 * 60 * 1000);
		const tick = await stub.tick();
		expect(tick.expiredReporterWait).toBe(true);
		expect((await stub.getPersistedState()).state).toBe("reproduced");
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
		expect(persisted.state).toBe("fixing");
		const log = await stub.getEventLog();
		expect(log.length).toBe(1);
	});

	async function driveToPreviewBuilding(
		stub: ReturnType<TestEnv["Orchestrator"]["getByName"]>,
		anchorNumber: number,
	): Promise<void> {
		await stub.event(makeEvent({ event: "investigate", arg: "diagnose it", anchorNumber }));
		await stub.debugSetStaleRun(
			"diag-run",
			Date.now(),
			`investigate-${anchorNumber}-diag`,
			"diagnose",
		);
		await stub.applyAgentResult({
			runId: "diag-run",
			result: { reproduced: true, summary: "Reproduced it." },
			pushed: false,
			ok: true,
		});
		await stub.event(makeEvent({ event: "fix", arg: "fix it", anchorNumber }));
		await stub.debugSetStaleRun("fix-run", Date.now(), `investigate-${anchorNumber}-fix`, "fix");
		await stub.applyAgentResult({
			runId: "fix-run",
			result: { fixed: true, summary: "Built a candidate." },
			pushed: true,
			ok: true,
		});
	}

	test("preview poll advances to awaiting_reporter once pkg.pr.new resolves", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await driveToPreviewBuilding(stub, 42);
		expect((await stub.getPersistedState()).state).toBe("preview_building");

		vi.stubGlobal("fetch", () => Promise.resolve(new Response("", { status: 200 })));
		await stub.debugSetPreviewPoll(Date.now() + 60_000, Date.now() - 1_000);
		const tick = await stub.tick();
		vi.unstubAllGlobals();

		expect(tick.previewPoll).toBe("ready");
		expect((await stub.getPersistedState()).state).toBe("awaiting_reporter");
	});

	test("preview poll gives up and falls back to reproduced past the budget", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await driveToPreviewBuilding(stub, 42);

		vi.stubGlobal("fetch", () => Promise.resolve(new Response("", { status: 404 })));
		await stub.debugSetPreviewPoll(Date.now() - 1_000, Date.now() - 1_000);
		const tick = await stub.tick();
		vi.unstubAllGlobals();

		expect(tick.previewPoll).toBe("failed");
		expect((await stub.getPersistedState()).state).toBe("reproduced");
	});

	test("invalid preview package configuration fails instead of retrying forever", async () => {
		testEnv.PREVIEW_PACKAGE = "../invalid";
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await driveToPreviewBuilding(stub, 42);

		await stub.debugSetPreviewPoll(Date.now() + 60_000, Date.now() - 1_000);
		const tick = await stub.tick();

		expect(tick.previewPoll).toBe("failed");
		expect(tick.recoveryError).toBeNull();
		expect((await stub.getPersistedState()).state).toBe("reproduced");
	});

	test("preview poll holds off before the next scheduled probe", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await driveToPreviewBuilding(stub, 42);

		await stub.debugSetPreviewPoll(Date.now() + 60_000, Date.now() + 60_000);
		const tick = await stub.tick();

		expect(tick.previewPoll).toBe("waiting");
		expect((await stub.getPersistedState()).state).toBe("preview_building");
	});

	// Records GitHub side-effect calls in order. `commentStatus` controls whether
	// the ask comment POST succeeds (201) or fails (500). Fetches to pkg.pr.new
	// always resolve 200 so the poll fires preview.ready.
	function githubCallRecorder(
		calls: string[],
		commentStatus: number,
		comments: string[] = [],
	): (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response> {
		return (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			if (url.startsWith("https://pkg.pr.new/")) {
				return Promise.resolve(new Response("", { status: 200 }));
			}
			if (method === "GET" && /\/issues\/\d+$/.test(url)) {
				return Promise.resolve(
					new Response(JSON.stringify({ title: "t", body: "b", user: { login: "alice" } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);
			}
			if (method === "GET" && url.includes("/comments")) {
				return Promise.resolve(new Response("[]", { status: 200 }));
			}
			if (method === "POST" && url.endsWith("/comments")) {
				calls.push("comment");
				const body = parseJsonBody(init?.body);
				if (
					typeof body === "object" &&
					body !== null &&
					"body" in body &&
					typeof body.body === "string"
				) {
					comments.push(body.body);
				}
				return Promise.resolve(new Response("{}", { status: commentStatus }));
			}
			if (url.includes("/labels")) {
				calls.push("labels");
				return Promise.resolve(new Response("[]", { status: 200 }));
			}
			return Promise.resolve(new Response("{}", { status: 200 }));
		};
	}

	// Credentials are captured at DO construction, so the private key must be set
	// before getByName -- which means the machine-driven path (investigate/fix)
	// would try to dispatch the runtime-less agent. These tests prime
	// preview_building directly to isolate the poll + ask flush.
	test("the preview ask posts the comment before flipping labels", async () => {
		const calls: string[] = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", githubCallRecorder(calls, 201));
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await stub.debugPrimePreviewBuilding(42, "Root cause: the loader drops the locale.");

		await stub.debugSetPreviewPoll(Date.now() + 60_000, Date.now() - 1_000);
		const tick = await stub.tick();
		expect(tick.previewPoll).toBe("ready");

		expect(calls[0]).toBe("comment");
		expect(calls).toContain("labels");
		expect((await stub.getPersistedState()).state).toBe("awaiting_reporter");
	});

	test("a failing ask comment leaves the labels unflipped and the effect pending", async () => {
		const calls: string[] = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", githubCallRecorder(calls, 500));
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await stub.debugPrimePreviewBuilding(42, "Root cause: the loader drops the locale.");

		await stub.debugSetPreviewPoll(Date.now() + 60_000, Date.now() - 1_000);
		await stub.tick();

		expect(calls).toContain("comment");
		expect(calls).not.toContain("labels");
		expect(await stub.getPendingSideEffectCount()).toBe(1);
	});

	test("draft PR titles distinguish bug fixes from directed implementations", async () => {
		const pullRequests: unknown[] = [];
		let pullNumber = 100;
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal(
			"fetch",
			(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const method = (init?.method ?? "GET").toUpperCase();
				if (method === "GET" && url.includes("/pulls?")) {
					return Promise.resolve(
						new Response("[]", { headers: { "content-type": "application/json" } }),
					);
				}
				if (method === "POST" && url.endsWith("/pulls")) {
					pullRequests.push(parseJsonBody(init?.body));
					pullNumber += 1;
					return Promise.resolve(
						new Response(
							JSON.stringify({ number: pullNumber, html_url: "https://example.test/pr" }),
							{
								status: 201,
								headers: { "content-type": "application/json" },
							},
						),
					);
				}
				return Promise.resolve(new Response("{}", { status: 200 }));
			},
		);

		for (const [anchorNumber, kind] of [
			[42, "bug"],
			[43, "enhancement"],
		] as const) {
			const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
			await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
			await stub.debugPrimePreviewBuilding(anchorNumber, "Candidate notes.", kind);
			await stub.event(
				makeEvent({ event: "preview.ready", arg: null, actor: "system", anchorNumber }),
			);
			await stub.event(makeEvent({ event: "confirm", arg: null, actor: "reporter", anchorNumber }));
		}

		expect(pullRequests).toMatchObject([
			{ title: "Fix #42", draft: true },
			{ title: "Implement #43", draft: true },
		]);
	});

	test("cleanupOnClose is a no-op without live credentials", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const outcome = await stub.cleanupOnClose(42);
		expect(outcome.kind).toBe("skipped");
	});
});
