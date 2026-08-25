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

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, test, vi } from "vitest";

import { applyInvestigationResult } from "../../.flue/lib/investigation-result.js";
import type { NormalizedEvent } from "../../.flue/lib/orchestrator.js";
import { RUN_TRACE_EVENT_LIMIT } from "../../.flue/lib/run-trace.js";

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

	test("direct fix persists the bug kind without requiring a diagnosis", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const outcome = await stub.event(
			makeEvent({ event: "fix", arg: "unwrap the media response envelope" }),
		);
		expect(outcome.kind).toBe("transition");
		if (outcome.kind === "transition") {
			expect(outcome.decision.action).toBe("investigate.implement");
		}

		const persisted = await stub.getPersistedState();
		expect(persisted.state).toBe("fixing");
		expect(persisted.kind).toBe("bug");
	});

	test("a successful legacy repro retains its diagnosis for implement", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ event: "repro", arg: null, anchorNumber: 42 }));
		await stub.debugSetStaleRun("repro-run", Date.now(), undefined, "repro");
		await stub.applyAgentResult({
			runId: "repro-run",
			result: {
				reproduced: true,
				summary: "The image field reads the wrapped response at the wrong level.",
			},
			pushed: false,
			ok: true,
		});

		expect((await stub.getPersistedState()).state).toBe("reproduced");
		expect(await stub.debugGetLastDiagnosis()).toMatchObject({
			runId: "repro-run",
			result: { reproduced: true },
		});

		const implement = await stub.event(
			makeEvent({ event: "implement", arg: "apply that fix", anchorNumber: 42 }),
		);
		expect(implement.kind).toBe("transition");
		if (implement.kind === "transition") {
			expect(implement.decision.action).toBe("investigate.fix");
		}
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

	test("public snapshots omit delivery and actor metadata", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ deliveryId: "private-delivery-id" }));

		const snapshot = await stub.getPublicSnapshot();
		expect(snapshot).toMatchObject({
			state: "fixing",
			kind: "enhancement",
			currentRunStartedAt: null,
			prNumber: null,
			progress: [],
		});
		expect(snapshot.transitions).toHaveLength(1);
		expect(snapshot.transitions[0]).toMatchObject({
			event: "implement",
			from: "unmanaged",
			to: "fixing",
		});
		expect(snapshot.transitions[0]).not.toHaveProperty("deliveryId");
		expect(snapshot.transitions[0]).not.toHaveProperty("actor");
	});

	test("public progress accepts only the current run and sanitizes text", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const startedAt = Date.now() - 1_000;
		await stub.debugSetStaleRun("current-run", startedAt);

		await expect(
			stub.recordPublicProgress({
				runId: "stale-run",
				kind: "workspace_ready",
				title: "Should not appear",
			}),
		).resolves.toBe(false);
		await expect(
			stub.recordPublicProgress({
				runId: "current-run",
				kind: "workspace_ready",
				title: "Workspace\nready",
				detail: "Checked out\tmain   and restored dependencies",
			}),
		).resolves.toBe(true);

		const snapshot = await stub.getPublicSnapshot();
		expect(snapshot.currentRunStartedAt).toBe(startedAt);
		expect(snapshot.progress).toMatchObject([
			{
				kind: "workspace_ready",
				title: "Workspace ready",
				detail: "Checked out main and restored dependencies",
			},
		]);
		expect(snapshot.progress[0]).not.toHaveProperty("runId");
	});

	test("persists an idempotent paginated public trace for the current run", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetStaleRun(
			"trace-run",
			Date.now() - 1_000,
			"investigate-trace-run",
			"implement",
		);
		const first = {
			key: "submission-1:1:turn",
			at: Date.now() - 500,
			kind: "turn" as const,
			title: "Model turn",
			detail: "deepseek-v4 · 100 tokens",
			tone: "active" as const,
			turnId: "turn-1",
			durationMs: 1_000,
			output: "Inspect the bridge.",
		};
		const second = {
			key: "submission-1:2:tool",
			at: Date.now(),
			kind: "tool" as const,
			title: "read_file",
			detail: null,
			tone: "success" as const,
			toolCallId: "call-1",
			durationMs: 5,
			output: "bridge source",
		};

		await expect(stub.recordRunTraceEvent({ runId: "stale-run", event: first })).resolves.toBe(
			false,
		);
		await expect(stub.recordRunTraceEvent({ runId: "trace-run", event: first })).resolves.toBe(
			true,
		);
		await expect(stub.recordRunTraceEvent({ runId: "trace-run", event: first })).resolves.toBe(
			true,
		);
		await expect(stub.recordRunTraceEvent({ runId: "trace-run", event: second })).resolves.toBe(
			true,
		);

		const latest = await stub.getPublicRunTrace({ limit: 1 });
		expect(latest.runs).toMatchObject([{ runId: "trace-run", mode: "implement", eventCount: 2 }]);
		expect(latest.selectedRunId).toBe("trace-run");
		expect(latest.events).toMatchObject([{ kind: "tool", output: "bridge source" }]);
		expect(latest.nextBefore).toEqual(expect.any(Number));

		const earlier = await stub.getPublicRunTrace({
			runId: "trace-run",
			before: latest.nextBefore ?? undefined,
			limit: 1,
		});
		expect(earlier.events).toMatchObject([{ kind: "turn", output: "Inspect the bridge." }]);
		expect(earlier.nextBefore).toBeNull();
	});

	test("bounds persisted trace history to the newest events", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetStaleRun(
			"bounded-trace-run",
			Date.now() - 1_000,
			"investigate-bounded-trace-run",
			"implement",
		);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				`WITH RECURSIVE sequence(value) AS (
					SELECT 1
					UNION ALL
					SELECT value + 1 FROM sequence WHERE value < ?
				)
				INSERT INTO run_trace_events
					(event_key, run_id, mode, recorded_at, event_type, payload)
				SELECT 'seed-' || value, 'bounded-trace-run', 'implement', value, 'turn', ?
				FROM sequence`,
				RUN_TRACE_EVENT_LIMIT + 1,
				JSON.stringify({
					key: "seed",
					at: 1,
					kind: "turn",
					title: "Model turn",
					tone: "active",
				}),
			);
		});

		await stub.recordRunTraceEvent({
			runId: "bounded-trace-run",
			event: {
				key: "newest-event",
				at: Date.now(),
				kind: "tool",
				title: "run_check",
				tone: "success",
			},
		});

		const trace = await stub.getPublicRunTrace({ limit: 1 });
		expect(trace.runs[0]?.eventCount).toBe(RUN_TRACE_EVENT_LIMIT);
		expect(trace.events[0]?.key).toBe("newest-event");
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

	test("an invalid maintainer command comments with valid alternatives without advancing state", async () => {
		const calls: string[] = [];
		const comments: string[] = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", githubCallRecorder(calls, 201, comments));
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		const outcome = await stub.event(
			makeEvent({
				event: "confirm",
				arg: null,
				actor: "maintainer",
				anchorNumber: 42,
				deliveryId: "invalid-confirm",
				dryRun: false,
			}),
		);
		expect(outcome.kind).toBe("noop");
		const persisted = await stub.getPersistedState();
		expect(persisted.state).toBe(null);
		expect(comments).toHaveLength(1);
		expect(comments[0]).toContain("`@emdashbot confirm` isn't available");
		expect(comments[0]).toContain("`@emdashbot fix <directive>`");
	});

	test("invalid classified commands name the resolved command in feedback", async () => {
		const calls: string[] = [];
		const comments: string[] = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", githubCallRecorder(calls, 201, comments));
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);

		const outcome = await stub.event(
			makeEvent({
				event: null,
				needsClassify: true,
				classifyText: "classified-confirm",
				labels: ["bot:bug", "bot:working"],
				anchorNumber: 42,
				deliveryId: "classified-invalid-confirm",
				dryRun: false,
			}),
		);

		expect(outcome.kind).toBe("noop");
		expect(comments).toHaveLength(1);
		expect(comments[0]).toContain("`@emdashbot confirm` isn't available");
		expect(comments[0]).not.toContain("I couldn't map that request");
	});

	test("a failed command-feedback comment recovers without posting a duplicate", async () => {
		let commentPosts = 0;
		let allowSuccess = false;
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal(
			"fetch",
			(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const method = (init?.method ?? "GET").toUpperCase();
				if (method === "GET" && url.includes("/comments")) {
					return Promise.resolve(new Response("[]", { status: 200 }));
				}
				if (method === "POST" && url.endsWith("/comments")) {
					commentPosts += 1;
					return Promise.resolve(new Response("{}", { status: allowSuccess ? 201 : 500 }));
				}
				return Promise.resolve(new Response("{}", { status: 200 }));
			},
		);
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		const event = makeEvent({
			event: "confirm",
			arg: null,
			actor: "maintainer",
			anchorNumber: 42,
			deliveryId: "recover-invalid-confirm",
			dryRun: false,
		});

		expect(await stub.enqueue(event)).toMatchObject({ kind: "admitted" });
		const failedTick = await stub.tick();
		expect(failedTick.inboxError).toContain("postIssueComment failed: 500");
		expect(await stub.getPendingSideEffectCount()).toBe(1);
		expect(await stub.getInboxDepth()).toBe(1);
		const failedPosts = commentPosts;

		allowSuccess = true;
		const recoveredTick = await stub.tick();
		expect(recoveredTick.inboxError).toBeNull();
		expect(commentPosts).toBe(failedPosts + 1);
		expect(await stub.getPendingSideEffectCount()).toBe(0);
		expect(await stub.getInboxDepth()).toBe(0);

		await stub.tick();
		expect(commentPosts).toBe(failedPosts + 1);
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

	test("retains the last successful diagnosis across failed and stale results", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ event: "investigate", arg: "diagnose it", anchorNumber: 42 }));
		await stub.debugSetStaleRun("good-diagnosis", Date.now(), undefined, "diagnose");
		await stub.applyAgentResult({
			runId: "good-diagnosis",
			result: {
				reproduced: true,
				demonstration: "failing-test",
				demonstratedReportedIssue: true,
				summary: "The locale cache key omits the requested locale.",
			},
			pushed: false,
			ok: true,
		});
		const stored = await stub.debugGetLastDiagnosis();
		expect(stored?.runId).toBe("good-diagnosis");

		await stub.debugSetStaleRun("failed-diagnosis", Date.now(), undefined, "diagnose");
		await stub.applyAgentResult({
			runId: "failed-diagnosis",
			result: {
				rootCauseFound: true,
				summary: "This failed run must not replace the earlier diagnosis.",
			},
			pushed: false,
			ok: false,
		});
		await stub.applyAgentResult({
			runId: "stale-diagnosis",
			result: {
				rootCauseFound: true,
				summary: "This stale run must not replace the earlier diagnosis.",
			},
			pushed: false,
			ok: true,
		});

		expect(await stub.debugGetLastDiagnosis()).toEqual(stored);
	});

	test("delivers one warning for a write run without moving its deadline", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const startedAt = Date.now() - 51 * 60_000;
		await stub.event(makeEvent({ anchorNumber: 42 }));
		await stub.debugSetStaleRun(
			"warning-run",
			startedAt,
			"investigate-42-warning-run",
			"implement",
		);

		const first = await stub.tick();
		expect(first.sentDeadlineWarning).toBe(true);
		const afterFirst = await stub.debugGetRunSchedule();
		expect(afterFirst.warningSentRunId).toBe("warning-run");
		expect(afterFirst.deadlineAt).toBe(startedAt + 60 * 60_000);

		const second = await stub.tick();
		expect(second.sentDeadlineWarning).toBe(false);
		expect((await stub.debugGetRunSchedule()).deadlineAt).toBe(afterFirst.deadlineAt);
	});

	test("does not stale-recover a write run at the read-mode deadline", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ anchorNumber: 42 }));
		await stub.debugSetStaleRun(
			"write-run",
			Date.now() - 31 * 60_000,
			"investigate-42-write-run",
			"implement",
		);

		const outcome = await stub.tick();
		expect(outcome.droppedStaleRun).toBe(false);
		expect((await stub.getPersistedState()).currentRunId).toBe("write-run");
	});

	test("keeps issue state and run lifecycle independently observable", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent());
		await stub.debugSetStaleRun(
			"implement-run",
			Date.now(),
			"investigate-42-implement-run",
			"implement",
		);

		const started = await stub.getPublicSnapshot();
		expect(started.state).toBe("fixing");
		expect(started.run).toMatchObject({
			mode: "implement",
			status: "running",
			phase: "prepare",
			plan: ["prepare", "edit", "finalize", "verify", "publish", "report"],
		});

		await stub.recordPublicProgress({
			runId: "implement-run",
			kind: "workspace_ready",
			title: "Workspace ready",
		});
		await stub.recordPublicProgress({
			runId: "implement-run",
			kind: "verification_passed",
			title: "Tests",
		});
		expect((await stub.getPublicSnapshot()).run?.phase).toBe("verify");

		await stub.applyAgentResult({
			runId: "implement-run",
			result: { implemented: true, summary: "Implemented the requested change." },
			pushed: true,
			ok: true,
		});
		const completed = await stub.getPublicSnapshot();
		expect(completed.state).toBe("preview_building");
		expect(completed.currentRunStartedAt).toBeNull();
		expect(completed.run).toMatchObject({ status: "succeeded", phase: "report" });
	});

	test("starts the run budget when workspace bootstrap completes", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const admittedAt = Date.now() - 5 * 60_000;
		await stub.debugSetStaleRun(
			"bootstrap-run",
			admittedAt,
			"investigate-42-bootstrap-run",
			"implement",
		);
		const readyAt = Date.now();

		await stub.recordPublicProgress({
			runId: "bootstrap-run",
			kind: "workspace_installing",
			title: "Installing dependencies",
		});
		await stub.recordPublicProgress({
			runId: "bootstrap-run",
			kind: "workspace_building",
			title: "Building workspace",
		});
		await stub.recordPublicProgress({
			runId: "bootstrap-run",
			kind: "workspace_ready",
			title: "Workspace ready",
		});

		const snapshot = await stub.getPublicSnapshot();
		expect(snapshot.run?.createdAt).toBe(admittedAt);
		expect(snapshot.run?.startedAt).toBeGreaterThanOrEqual(readyAt);
		expect(snapshot.currentRunStartedAt).toBe(snapshot.run?.startedAt);
		expect(snapshot.run?.deadlineAt).toBe((snapshot.run?.startedAt ?? 0) + 60 * 60_000);
		expect(snapshot.progress.slice(-3).map((entry: { kind: string }) => entry.kind)).toEqual([
			"workspace_installing",
			"workspace_building",
			"workspace_ready",
		]);
	});

	test("records a reset active run as cancelled", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent());
		await stub.debugSetStaleRun(
			"cancelled-run",
			Date.now(),
			"investigate-42-cancelled-run",
			"implement",
		);

		await stub.event(makeEvent({ event: "reset", arg: null }));

		expect((await stub.getPublicSnapshot()).run).toMatchObject({
			status: "cancelled",
			phase: "prepare",
		});
	});

	test("posts workspace preparation before reusing the comment for the agent plan", async () => {
		const requests: Array<{ method: string; url: string; body: string }> = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			const body = typeof init?.body === "string" ? init.body : "";
			requests.push({ method, url, body });
			if (method === "POST" && url.endsWith("/comments")) {
				return Promise.resolve(
					new Response(JSON.stringify({ id: 776 }), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response("{}", { status: 200 }));
		});
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await stub.debugPrimeFixing(42);
		await stub.debugSetStaleRun(
			"preparing-run",
			Date.now(),
			"investigate-42-preparing-run",
			"implement",
		);

		await stub.prepareWorkPlanComment({
			runId: "preparing-run",
			summary: "Implement adapter support.",
		});
		expect((await stub.getPublicSnapshot()).workPlan).toMatchObject({
			summary: "Implement adapter support.",
			steps: [{ id: "prepare-workspace", status: "in_progress" }],
		});
		await stub.updateWorkPlan({
			runId: "preparing-run",
			summary: "Implement adapter support.",
			steps: [{ id: "implement", title: "Implement the adapter", status: "in_progress" }],
		});

		const posts = requests.filter(
			(request) => request.method === "POST" && request.url.endsWith("/comments"),
		);
		const patches = requests.filter(
			(request) => request.method === "PATCH" && request.url.endsWith("/issues/comments/776"),
		);
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toContain("### Preparing workspace");
		expect(patches.at(-1)?.body).toContain("### Working on it");
	});

	test("creates one evolving work-plan comment and finalizes it in place", async () => {
		const requests: Array<{ method: string; url: string; body: string }> = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			const body = typeof init?.body === "string" ? init.body : "";
			requests.push({ method, url, body });
			if (method === "POST" && url.endsWith("/comments")) {
				return Promise.resolve(
					new Response(JSON.stringify({ id: 777, html_url: "https://example.test/comment/777" }), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				);
			}
			return Promise.resolve(new Response("{}", { status: 200 }));
		});
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await stub.debugPrimeFixing(42);
		await stub.debugSetStaleRun(
			"planned-run",
			Date.now(),
			"investigate-42-planned-run",
			"implement",
		);

		await stub.updateWorkPlan({
			runId: "planned-run",
			summary: "Add the requested command.",
			steps: [
				{ id: "inspect", title: "Inspect the CLI", status: "completed" },
				{ id: "implement", title: "Implement the command", status: "in_progress" },
			],
		});
		await stub.updateWorkPlan({
			runId: "planned-run",
			summary: "Add the requested command.",
			steps: [
				{ id: "inspect", title: "Inspect the CLI", status: "completed" },
				{ id: "implement", title: "Implement the command", status: "blocked" },
			],
		});
		await stub.applyAgentResult({
			runId: "planned-run",
			result: { implemented: true, summary: "The candidate could not be verified remotely." },
			pushed: false,
			ok: true,
		});

		const commentPosts = requests.filter(
			(request) => request.method === "POST" && request.url.endsWith("/comments"),
		);
		const commentPatches = requests.filter(
			(request) => request.method === "PATCH" && request.url.endsWith("/issues/comments/777"),
		);
		expect(commentPosts).toHaveLength(1);
		expect(commentPatches.length).toBeGreaterThanOrEqual(2);
		expect(commentPosts[0]?.body).toContain("emdashbot-run:planned-run");
		expect(commentPatches.at(-1)?.body).toContain("### Failed");
		expect(commentPatches.at(-1)?.body).toContain("The candidate could not be verified remotely.");
		expect((await stub.getPublicSnapshot()).workPlan?.summary).toBe("Add the requested command.");
	});

	test("reset finalizes the active work-plan comment as cancelled", async () => {
		const patchedBodies: string[] = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			const body = typeof init?.body === "string" ? parseJsonBody(init.body) : null;
			if (method === "POST" && url.endsWith("/comments")) {
				return Promise.resolve(
					new Response(JSON.stringify({ id: 888 }), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				);
			}
			if (method === "PATCH" && url.endsWith("/issues/comments/888")) {
				if (typeof body === "object" && body !== null && "body" in body) {
					patchedBodies.push(String(body.body));
				}
			}
			return Promise.resolve(new Response("{}", { status: 200 }));
		});
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await stub.debugPrimeFixing(42);
		await stub.debugSetStaleRun(
			"cancelled-plan-run",
			Date.now(),
			"investigate-42-cancelled-plan-run",
			"implement",
		);
		await stub.updateWorkPlan({
			runId: "cancelled-plan-run",
			summary: "Implement the requested change.",
			steps: [{ id: "implement", title: "Implement the change", status: "in_progress" }],
		});

		await stub.event(makeEvent({ event: "reset", arg: null }));

		expect(patchedBodies.at(-1)).toContain("### Cancelled");
		expect(patchedBodies.at(-1)).toContain("Run cancelled by reset.");
	});

	test("retrying a failed implementation preserves its write mode", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.event(makeEvent({ anchorNumber: 42 }));
		await stub.debugSetStaleRun(
			"failed-implementation",
			Date.now(),
			"investigate-42-failed-implementation",
			"implement",
		);
		await stub.applyAgentResult({
			runId: "failed-implementation",
			result: { implemented: false, summary: "Candidate publication failed." },
			pushed: false,
			ok: false,
		});

		const retry = await stub.event(makeEvent({ event: "retry", arg: null, anchorNumber: 42 }));

		expect(retry.kind).toBe("transition");
		if (retry.kind === "transition") {
			expect(retry.decision.action).toBe("investigate.implement");
		}
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

	test("resume without a saved timed-out run comments and leaves the issue failed", async () => {
		const calls: string[] = [];
		const comments: string[] = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", githubCallRecorder(calls, 201, comments));
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await stub.debugPrimeFailed(42);

		const outcome = await stub.event(
			makeEvent({
				event: "resume",
				arg: null,
				anchorNumber: 42,
				deliveryId: "resume-without-state",
				dryRun: false,
				labels: ["bot:enhancement", "bot:failed"],
			}),
		);

		expect(outcome.kind).toBe("noop");
		expect((await stub.getPersistedState()).state).toBe("failed");
		expect(comments.at(-1)).toContain("There isn't a saved timed-out run to resume");
	});

	test("resume restores the saved run identity, mode, and active state", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugPrimeFailed(42);
		await stub.debugSetResumableRun({
			runId: "timed-out-run",
			agentId: "investigate-42-timed-out-run",
			mode: "implement",
			state: "fixing",
			attemptStartedAt: Date.now() - 60 * 60_000,
			timedOutAt: Date.now(),
			summary: "The implementation is complete but one focused test still fails.",
		});

		const outcome = await stub.event(
			makeEvent({
				event: "resume",
				arg: "continue with the failing test",
				anchorNumber: 42,
				deliveryId: "resume-saved-run",
				labels: ["bot:enhancement", "bot:failed"],
			}),
		);

		expect(outcome.kind).toBe("transition");
		if (outcome.kind === "transition") {
			expect(outcome.decision.action).toBe("investigate.resume");
			expect(outcome.decision.to).toBe("fixing");
		}
		expect(await stub.getPersistedState()).toMatchObject({
			state: "fixing",
			currentRunId: "timed-out-run",
			currentAgentId: "investigate-42-timed-out-run",
		});
		expect(await stub.debugGetResumableRun()).toBeNull();
	});

	test("a timed-out run posts its checkpoint and resume command", async () => {
		const calls: string[] = [];
		const comments: string[] = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", githubCallRecorder(calls, 201, comments));
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await stub.debugPrimeFixing(42);
		await stub.debugSetStaleRun(
			"timed-out-comment-run",
			Date.now() - 61 * 60_000,
			"investigate-42-timed-out-comment-run",
			"implement",
		);

		const outcome = await stub.tick();
		expect(outcome.droppedStaleRun).toBe(true);
		expect(comments.at(-1)).toContain(
			"The run stopped at its execution deadline before it could provide a checkpoint summary.",
		);
		expect(comments.at(-1)).toContain("`@emdashbot resume`");
		expect(comments.at(-1)).toContain("Failed stage: `timeout`");
		expect(comments.at(-1)).toContain("Run: `timed-out-comment-run`");
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
		expect(await stub.debugGetResumableRun()).toMatchObject({
			runId: "ghost-run",
			agentId: "investigate-999-ghost-run",
			mode: "repro",
			state: "fixing",
		});
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

	test("a rejected resume returns to failed without discarding its checkpoint", async () => {
		const calls: string[] = [];
		const comments: string[] = [];
		testEnv.GITHUB_APP_PRIVATE_KEY = "test-key-present";
		vi.stubGlobal("fetch", githubCallRecorder(calls, 201, comments));
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await stub.debugSetPendingResume({
			runId: "rejected-resume-run",
			agentId: "investigate-999-rejected-resume-run",
			deliveryId: "rejected-resume",
			startedAt: Date.now(),
			dispatchError: "resume admission rejected",
		});

		await stub.tick();

		expect(await stub.getPersistedState()).toMatchObject({
			state: "failed",
			currentRunId: null,
			currentAgentId: null,
		});
		expect(await stub.debugGetResumableRun()).toMatchObject({
			runId: "rejected-resume-run",
			agentId: "investigate-999-rejected-resume-run",
			mode: "implement",
			state: "fixing",
		});
		expect(await stub.getPendingSideEffectCount()).toBe(0);
		expect(comments.at(-1)).toContain("I couldn't resume the saved run");
	});

	test("a confirmed resume receipt atomically deduplicates its delivery", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetPendingResume({
			runId: "confirmed-resume-run",
			agentId: "investigate-999-confirmed-resume-run",
			deliveryId: "confirmed-resume-delivery",
			startedAt: Date.now(),
			dispatchAttempt: "confirmed-resume-attempt",
		});

		await stub.debugConfirmPendingResumeReceipt("confirmed-resume-submission");
		const redelivery = await stub.event(
			makeEvent({
				event: "resume",
				arg: null,
				anchorNumber: 999,
				deliveryId: "confirmed-resume-delivery",
				labels: ["bot:enhancement", "bot:failed"],
			}),
		);

		expect(redelivery).toEqual({
			kind: "duplicate",
			deliveryId: "confirmed-resume-delivery",
		});
	});

	test("an agent result confirms and deduplicates an uncertain resume admission", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetPendingResume({
			runId: "completed-resume-run",
			agentId: "investigate-999-completed-resume-run",
			deliveryId: "completed-resume-delivery",
			startedAt: Date.now(),
			dispatchAttempt: "uncertain-completed-resume-attempt",
		});

		const completion = await stub.applyAgentResult({
			runId: "completed-resume-run",
			result: { implemented: true, summary: "Finished the resumed implementation." },
			pushed: true,
			ok: true,
		});
		expect(completion.kind).toBe("transition");

		const redelivery = await stub.event(
			makeEvent({
				event: "resume",
				arg: null,
				anchorNumber: 999,
				deliveryId: "completed-resume-delivery",
				labels: ["bot:enhancement", "bot:failed"],
			}),
		);
		expect(redelivery).toEqual({
			kind: "duplicate",
			deliveryId: "completed-resume-delivery",
		});
	});

	test("a failed resumed run preserves its checkpoint for another resume", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetPendingResume({
			runId: "failed-resume-run",
			agentId: "investigate-999-failed-resume-run",
			deliveryId: "failed-resume-delivery",
			startedAt: Date.now(),
			dispatchAttempt: "failed-resume-attempt",
		});

		const completion = await stub.applyAgentResult({
			runId: "failed-resume-run",
			result: {
				implemented: false,
				failureStage: "verification",
				summary: "The saved candidate still needs final verification.",
			},
			pushed: false,
			ok: true,
		});

		expect(completion.kind).toBe("transition");
		expect((await stub.getPersistedState()).state).toBe("failed");
		expect(await stub.debugGetResumableRun()).toMatchObject({
			runId: "failed-resume-run",
			agentId: "investigate-999-failed-resume-run",
			mode: "implement",
			state: "fixing",
			summary: "The saved candidate still needs final verification.",
		});
	});

	test("stale recovery consumes an uncertain resume delivery", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await stub.debugSetPendingResume({
			runId: "uncertain-resume-run",
			agentId: "investigate-999-abort-false-missing",
			deliveryId: "uncertain-resume-delivery",
			startedAt: Date.now() - 61 * 60_000,
			dispatchAttempt: "uncertain-resume-attempt",
		});

		const recovery = await stub.tick();
		expect(recovery.droppedStaleRun).toBe(true);
		const redelivery = await stub.event(
			makeEvent({
				event: "resume",
				arg: null,
				anchorNumber: 999,
				deliveryId: "uncertain-resume-delivery",
				labels: ["bot:enhancement", "bot:failed"],
			}),
		);

		expect(redelivery).toEqual({
			kind: "duplicate",
			deliveryId: "uncertain-resume-delivery",
		});
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

	test("draft PRs use agent-authored copy with a legacy fallback", async () => {
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

		const customCopyStub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await customCopyStub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await customCopyStub.debugPrimeFixing(42);
		await customCopyStub.debugSetStaleRun(
			"implement-run",
			Date.now(),
			"investigate-42-implement-run",
			"implement",
		);
		await customCopyStub.applyAgentResult({
			runId: "implement-run",
			result: {
				implemented: true,
				summary: "Keeps the selected locale when loading content.",
				pullRequest: {
					title: "fix(core): preserve the requested locale",
					description: "Keeps the selected locale when loading content.",
				},
			},
			pushed: true,
			ok: true,
		});
		await customCopyStub.event(
			makeEvent({ event: "preview.ready", arg: null, actor: "system", anchorNumber: 42 }),
		);
		await customCopyStub.event(
			makeEvent({ event: "confirm", arg: null, actor: "reporter", anchorNumber: 42 }),
		);

		const legacyStub = testEnv.Orchestrator.getByName(uniqueIssueName());
		await legacyStub.debugSetTokenCache("cached-token", Date.now() + 60 * 60 * 1000);
		await legacyStub.debugPrimePreviewBuilding(43, "Candidate notes.", "enhancement");
		await legacyStub.event(
			makeEvent({ event: "preview.ready", arg: null, actor: "system", anchorNumber: 43 }),
		);
		await legacyStub.event(
			makeEvent({ event: "confirm", arg: null, actor: "reporter", anchorNumber: 43 }),
		);

		expect(pullRequests).toMatchObject([
			{
				title: "fix(core): preserve the requested locale",
				body: expect.stringContaining("Keeps the selected locale when loading content."),
				draft: true,
			},
			{
				title: "Implement #43",
				body: expect.stringContaining("## What does this PR do?"),
				draft: true,
			},
		]);
	});

	test("cleanupOnClose is a no-op without live credentials", async () => {
		const stub = testEnv.Orchestrator.getByName(uniqueIssueName());
		const outcome = await stub.cleanupOnClose(42);
		expect(outcome.kind).toBe("skipped");
	});
});
