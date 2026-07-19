// Unit tests for the pure router logic. Ported from the closed
// feat/bot-state-machine branch (router.test.cjs, node:test) to vitest.
// Same 32 cases, TypeScript-native, with narrow helpers for the Decision
// union.

import { describe, expect, test } from "vitest";

import type { CommentDecision, Decision } from "../../.flue/lib/router.js";
import {
	classifierCommands,
	currentState,
	invariantProblems,
	isDestructive,
	outcomeFromResult,
	parseCommand,
	parseMention,
	replyFooter,
	resolve,
	resolveComment,
} from "../../.flue/lib/router.js";

// Narrowing helpers: the Decision union has different fields per `.kind`, and
// the original .cjs tests punned across them. Asserting the discriminant once
// gives us typed access to the rest of the fields inline.

function assertTransition(
	d: Decision | CommentDecision,
): asserts d is Extract<Decision, { kind: "transition" }> {
	expect(d.kind).toBe("transition");
}

function assertNoop(
	d: Decision | CommentDecision,
): asserts d is Extract<Decision, { kind: "noop" }> {
	expect(d.kind).toBe("noop");
}

function assertReadonly(
	d: Decision | CommentDecision,
): asserts d is Extract<Decision, { kind: "readonly" }> {
	expect(d.kind).toBe("readonly");
}

function assertClassify(
	d: CommentDecision,
): asserts d is Extract<CommentDecision, { kind: "classify" }> {
	expect(d.kind).toBe("classify");
}

const MENTION_TEXT_RE = /mention/;
const FOOTER_IMPLEMENT_RE = /@emdashbot implement/;
const FOOTER_DECLINE_RE = /@emdashbot decline/;

describe("router", () => {
	test("currentState reads the single state label", () => {
		expect(currentState(["bot:bug", "bot:blocked"])).toBe("blocked");
		expect(currentState(["bot:bug"])).toBe("unmanaged"); // no state label
		expect(currentState([])).toBe("unmanaged"); // no labels at all
		expect(currentState(["bot:blocked", "bot:working"])).toBe(null); // two states
	});

	test("implement works on an untriaged issue (no triage step required)", () => {
		const d = resolve({
			labels: [],
			event: "implement",
			arg: "add dark mode",
			actor: "maintainer",
		});
		assertTransition(d);
		expect(d.from).toBe("unmanaged");
		expect(d.to).toBe("working");
		expect(d.action).toBe("investigate.implement");
	});

	test("repro works on an untriaged issue", () => {
		const d = resolve({ labels: ["bot:bug"], event: "repro", actor: "maintainer" });
		assertTransition(d);
		expect(d.from).toBe("unmanaged");
		expect(d.to).toBe("working");
	});

	test("parseCommand: destructive verb with prose on a later line does NOT fire", () => {
		// Regression for the multiline-bypass bug.
		expect(parseCommand("@emdashbot decline\nplease don't")).toBe(null);
		expect(parseCommand("@emdashbot take over\nactually nevermind")).toBe(null);
		// Single-line bare verbs still fire.
		expect(parseCommand("@emdashbot decline")).toEqual({ event: "decline", arg: null });
	});

	test("parseCommand is strict: only an exact bare verb is deterministic", () => {
		expect(parseCommand("@emdashbot retry")).toEqual({ event: "retry", arg: null });
		expect(parseCommand("@emdashbot take over")).toEqual({ event: "take_over", arg: null });
		expect(parseCommand("@emdashbot confirmed")).toEqual({ event: "confirm", arg: null }); // alias
		expect(parseCommand("@emdashbot hand back please")).toBe(null); // extra word
		expect(parseCommand("@emdashbot implement use a LEFT JOIN")).toBe(null); // arg -> classifier
		expect(parseCommand("@emdashbot I don't think we should implement this")).toBe(null); // prose
		expect(parseCommand("please @emdashbot retry")).toBe(null); // must start the line
		expect(parseCommand("@emdashbot frobnicate")).toBe(null); // unknown verb
	});

	test("classifierCommands excludes destructive events", () => {
		const cmds = new Set(classifierCommands("blocked").map((c) => c.event));
		expect(cmds.has("implement")).toBe(true);
		expect(cmds.has("decline")).toBe(false);
		expect(cmds.has("take_over")).toBe(false);
	});

	test("isDestructive flags decline and take_over only", () => {
		expect(isDestructive("decline")).toBe(true);
		expect(isDestructive("take_over")).toBe(true);
		expect(isDestructive("implement")).toBe(false);
		expect(isDestructive("retry")).toBe(false);
	});

	test("resolve: blocked accepts implement (kills the old skip sink)", () => {
		const d = resolve({
			labels: ["bot:bug", "bot:blocked"],
			event: "implement",
			arg: "do X",
			actor: "maintainer",
		});
		assertTransition(d);
		expect(d.to).toBe("working");
		expect(d.action).toBe("investigate.implement");
		expect(d.addLabel).toBe("bot:working");
		expect(d.removeLabels).toContain("bot:blocked");
		expect(d.removeLabels).not.toContain("bot:working");
	});

	test("resolve: in_review accepts revise (PR feedback bridge)", () => {
		const d = resolve({
			labels: ["bot:bug", "bot:in-review"],
			event: "revise",
			arg: "fix the test",
			actor: "maintainer",
		});
		assertTransition(d);
		expect(d.to).toBe("working");
		expect(d.action).toBe("investigate.revise");
	});

	test("resolve: triage implement skips the repro gate (feature lane)", () => {
		const d = resolve({
			labels: ["bot:enhancement", "bot:triage"],
			event: "implement",
			actor: "maintainer",
		});
		assertTransition(d);
		expect(d.to).toBe("working");
		expect(d.action).toBe("investigate.implement");
	});

	test("resolve: terminals reopen, never dead", () => {
		for (const label of ["bot:done", "bot:declined"]) {
			const d = resolve({ labels: ["bot:bug", label], event: "reopen", actor: "maintainer" });
			assertTransition(d);
			expect(d.to).toBe("triage");
		}
	});

	test("resolve: pr.closed moves in_review / working / awaiting_feedback to blocked", () => {
		for (const label of ["bot:in-review", "bot:working", "bot:awaiting-feedback"] as const) {
			const d = resolve({
				labels: ["bot:bug", label],
				event: "pr.closed",
				actor: "system",
			});
			assertTransition(d);
			expect(d.to).toBe("blocked");
			expect(d.action).toBe(null);
		}
	});

	test("resolve: pr.merged still goes to done from in_review", () => {
		const d = resolve({
			labels: ["bot:bug", "bot:in-review"],
			event: "pr.merged",
			actor: "system",
		});
		assertTransition(d);
		expect(d.to).toBe("done");
	});

	test("resolve: authorization is enforced per event", () => {
		const d = resolve({
			labels: ["bot:bug", "bot:blocked"],
			event: "implement",
			actor: "reporter",
		});
		assertNoop(d);
	});

	test("resolve: confirm allowed for reporter", () => {
		const d = resolve({
			labels: ["bot:bug", "bot:awaiting-feedback"],
			event: "confirm",
			actor: "reporter",
		});
		assertTransition(d);
		expect(d.to).toBe("in_review");
	});

	test("resolve: unknown transition is a no-op, not an error", () => {
		const d = resolve({
			labels: ["bot:bug", "bot:triage"],
			event: "confirm",
			actor: "maintainer",
		});
		assertNoop(d);
	});

	test("resolve: status/help are read-only", () => {
		const d = resolve({
			labels: ["bot:bug", "bot:working"],
			event: "status",
			actor: "reporter",
		});
		assertReadonly(d);
	});

	test("invariantProblems flags 0 or >1 of each dimension", () => {
		expect(invariantProblems(["bot:bug", "bot:blocked"])).toEqual([]);
		expect(invariantProblems(["bot:blocked"]).length).toBe(1); // missing kind
		expect(invariantProblems(["bot:bug"]).length).toBe(1); // missing state
		expect(invariantProblems(["bot:bug", "bot:blocked", "bot:working"]).length).toBe(1); // two states
	});

	test("resolveComment: bare feedback on a bot PR maps to revise", () => {
		const d = resolveComment({
			labels: ["bot:bug", "bot:in-review"],
			body: "@emdashbot the test name is wrong, rename it",
			actor: "maintainer",
			allowDefault: true,
		});
		assertTransition(d);
		expect(d.to).toBe("working");
		expect(d.action).toBe("investigate.revise");
		expect(d.arg).toBe("the test name is wrong, rename it");
	});

	test("resolveComment: explicit verb wins over the default", () => {
		const d = resolveComment({
			labels: ["bot:bug", "bot:in-review"],
			body: "@emdashbot take over",
			actor: "maintainer",
			allowDefault: true,
		});
		assertTransition(d);
		expect(d.to).toBe("human_owned");
	});

	test("resolveComment: the @emdashbot mention is still required", () => {
		const d = resolveComment({
			labels: ["bot:bug", "bot:in-review"],
			body: "the test name is wrong",
			actor: "maintainer",
			allowDefault: true,
		});
		assertNoop(d);
		expect(d.reason).toMatch(MENTION_TEXT_RE);
	});

	test("reset: works even when the item has conflicting state labels", () => {
		const d = resolve({
			labels: ["bot:bug", "bot:working", "bot:blocked"],
			event: "reset",
			actor: "maintainer",
		});
		assertTransition(d);
		expect(d.to).toBe("triage");
		expect(d.removeLabels).toContain("bot:working");
		expect(d.removeLabels).toContain("bot:blocked");
	});

	test("reset: bare-verb only (destructive) -> not offered to the classifier", () => {
		expect(isDestructive("reset")).toBe(true);
	});

	test("resolve: entry from unmanaged assigns the default kind when none is set", () => {
		const d = resolve({ labels: [], event: "repro", actor: "maintainer" });
		assertTransition(d);
		expect(d.addLabels).toContain("bot:working");
		expect(d.addLabels).toContain("bot:bug");
	});

	test("resolve: entry from triage also replaces a mismatched kind (post-reset)", () => {
		const d = resolve({
			labels: ["bot:enhancement", "bot:triage"],
			event: "repro",
			actor: "maintainer",
		});
		assertTransition(d);
		expect(d.addLabels).toContain("bot:bug");
		expect(d.removeLabels).toContain("bot:enhancement");
	});

	test("resolve: entry from unmanaged replaces a mismatched existing kind", () => {
		const d = resolve({ labels: ["bot:enhancement"], event: "repro", actor: "maintainer" });
		assertTransition(d);
		expect(d.addLabels).toContain("bot:bug");
		expect(d.removeLabels).toContain("bot:enhancement");
	});

	test("resolve: entry from unmanaged keeps a matching existing kind", () => {
		const d = resolve({ labels: ["bot:bug"], event: "repro", actor: "maintainer" });
		assertTransition(d);
		expect(d.addLabels).toEqual(["bot:working"]); // does not re-add bot:bug
		expect(d.removeLabels).not.toContain("bot:bug");
	});

	test("resolveComment: free text in blocked routes to the classifier with safe candidates", () => {
		const d = resolveComment({
			labels: ["bot:bug", "bot:blocked"],
			body: "@emdashbot please try fixing it in the loader",
			actor: "maintainer",
			allowDefault: false,
		});
		assertClassify(d);
		expect(d.state).toBe("blocked");
		const events = new Set(d.commands.map((c) => c.event));
		expect(events.has("implement")).toBe(true);
		expect(events.has("decline")).toBe(false);
		expect(d.text).toBe("please try fixing it in the loader");
	});

	test("resolveComment: whitespace-only mention renders status, not a classifier call", () => {
		const d = resolveComment({
			labels: ["bot:bug", "bot:blocked"],
			body: "@emdashbot   ",
			actor: "maintainer",
			allowDefault: false,
		});
		assertReadonly(d);
		expect(d.state).toBe("blocked");
	});

	test("resolveComment: bare @emdashbot without trailing whitespace yields status", () => {
		expect(parseMention("@emdashbot")).toBe("");
		const d = resolveComment({
			labels: ["bot:bug", "bot:blocked"],
			body: "@emdashbot",
			actor: "maintainer",
			allowDefault: false,
		});
		assertReadonly(d);
		expect(d.event).toBe("status");
		expect(d.state).toBe("blocked");
	});

	test("parseMention captures text beginning on the following line", () => {
		expect(parseMention("@emdashbot\nplease investigate this")).toBe("please investigate this");
	});

	test("resolveComment: bare destructive verb still fires deterministically", () => {
		const d = resolveComment({
			labels: ["bot:bug", "bot:blocked"],
			body: "@emdashbot decline",
			actor: "maintainer",
			allowDefault: false,
		});
		assertTransition(d);
		expect(d.to).toBe("declined");
	});

	test("outcomeFromResult maps the agent's flat result to an agent.* event", () => {
		expect(outcomeFromResult({ ok: false })).toBe("agent.failed");
		expect(outcomeFromResult({ ok: true, result: null })).toBe("agent.failed");
		expect(outcomeFromResult({ ok: true, result: { skipped: true } })).toBe("agent.skipped");
		expect(
			outcomeFromResult({
				ok: true,
				result: { skipped: false, verdict: "intended-behavior" },
			}),
		).toBe("agent.by_design");
		expect(
			outcomeFromResult({
				ok: true,
				result: { skipped: false, reproduced: false, verdict: "bug" },
			}),
		).toBe("agent.not_reproduced");
		expect(
			outcomeFromResult({
				ok: true,
				result: { reproduced: true, fixed: true, verdict: "bug" },
				pushed: true,
			}),
		).toBe("agent.fix_ready");
		expect(
			outcomeFromResult({
				ok: true,
				result: { reproduced: true, fixed: false, verdict: "bug" },
			}),
		).toBe("agent.reproduced");
	});

	test("outcomeFromResult: fixed but NOT pushed demotes to failed", () => {
		expect(
			outcomeFromResult({
				ok: true,
				result: { reproduced: true, fixed: true },
				pushed: false,
			}),
		).toBe("agent.failed");
		expect(outcomeFromResult({ ok: true, result: { reproduced: true, fixed: true } })).toBe(
			"agent.failed",
		);
	});

	test("outcomeFromResult allows implement and revise runs to produce a fix", () => {
		for (const mode of ["implement", "revise"] as const) {
			const input = {
				ok: true,
				result: { fixed: true },
				pushed: true,
				mode,
			};
			expect(outcomeFromResult(input)).toBe("agent.fix_ready");
		}
	});

	test("outcomeFromResult feeds resolve to advance the machine end-to-end", () => {
		const event = outcomeFromResult({
			ok: true,
			result: { reproduced: true, fixed: true },
			pushed: true,
		});
		const d = resolve({ labels: ["bot:bug", "bot:working"], event, actor: "system" });
		assertTransition(d);
		expect(d.to).toBe("awaiting_feedback");
		expect(d.action).toBe(null);
	});

	test("replyFooter lists the offered commands for the state", () => {
		const footer = replyFooter("blocked");
		expect(footer).toMatch(FOOTER_IMPLEMENT_RE);
		expect(footer).toMatch(FOOTER_DECLINE_RE);
	});
});
