// Unit tests for the pure router logic. Run: node --test .github/bot/router.cjs
const test = require("node:test");
const assert = require("node:assert/strict");

const r = require("./router.cjs");

// Regex literals hoisted to module scope.
const MENTION_TEXT_RE = /mention/;
const FOOTER_IMPLEMENT_RE = /@emdashbot implement/;
const FOOTER_DECLINE_RE = /@emdashbot decline/;

test("currentState reads the single state label", () => {
	assert.equal(r.currentState(["bot:bug", "bot:blocked"]), "blocked");
	assert.equal(r.currentState(["bot:bug"]), "unmanaged", "no state label -> unmanaged");
	assert.equal(r.currentState([]), "unmanaged", "no labels at all -> unmanaged");
	assert.equal(r.currentState(["bot:blocked", "bot:working"]), null, "two states -> null");
});

test("implement works on an untriaged issue (no triage step required)", () => {
	const d = r.resolve({
		labels: [],
		event: "implement",
		arg: "add dark mode",
		actor: "maintainer",
	});
	assert.equal(d.kind, "transition");
	assert.equal(d.from, "unmanaged");
	assert.equal(d.to, "working");
	assert.equal(d.action, "investigate.implement");
});

test("repro works on an untriaged issue", () => {
	const d = r.resolve({ labels: ["bot:bug"], event: "repro", actor: "maintainer" });
	assert.equal(d.from, "unmanaged");
	assert.equal(d.to, "working");
});

test("parseCommand is strict: only an exact bare verb is deterministic", () => {
	assert.deepEqual(r.parseCommand("@emdashbot retry"), { event: "retry", arg: null });
	assert.deepEqual(r.parseCommand("@emdashbot take over"), { event: "take_over", arg: null });
	assert.deepEqual(
		r.parseCommand("@emdashbot confirmed"),
		{ event: "confirm", arg: null },
		"alias",
	);
	// Any extra word routes to the classifier, not a deterministic command.
	assert.equal(r.parseCommand("@emdashbot hand back please"), null, "extra word -> null");
	assert.equal(r.parseCommand("@emdashbot implement use a LEFT JOIN"), null, "arg -> classifier");
	assert.equal(
		r.parseCommand("@emdashbot I don't think we should implement this"),
		null,
		"prose containing a verb does not trigger",
	);
	assert.equal(r.parseCommand("please @emdashbot retry"), null, "must start the line");
	assert.equal(r.parseCommand("@emdashbot frobnicate"), null, "unknown verb -> null");
});

test("classifierCommands excludes destructive events", () => {
	const cmds = new Set(r.classifierCommands("blocked").map((c) => c.event));
	assert.ok(cmds.has("implement"), "implement is offered to free text");
	assert.ok(!cmds.has("decline"), "decline is destructive -> bare verb only");
	assert.ok(!cmds.has("take_over"), "take_over is destructive -> bare verb only");
});

test("isDestructive flags decline and take_over only", () => {
	assert.equal(r.isDestructive("decline"), true);
	assert.equal(r.isDestructive("take_over"), true);
	assert.equal(r.isDestructive("implement"), false);
	assert.equal(r.isDestructive("retry"), false);
});

test("resolve: blocked accepts implement (kills the old skip sink)", () => {
	const d = r.resolve({
		labels: ["bot:bug", "bot:blocked"],
		event: "implement",
		arg: "do X",
		actor: "maintainer",
	});
	assert.equal(d.kind, "transition");
	assert.equal(d.to, "working");
	assert.equal(d.action, "investigate.implement");
	assert.equal(d.addLabel, "bot:working");
	assert.ok(d.removeLabels.includes("bot:blocked"));
	assert.ok(!d.removeLabels.includes("bot:working"));
});

test("resolve: in_review accepts revise (PR feedback bridge)", () => {
	const d = r.resolve({
		labels: ["bot:bug", "bot:in-review"],
		event: "revise",
		arg: "fix the test",
		actor: "maintainer",
	});
	assert.equal(d.to, "working");
	assert.equal(d.action, "investigate.revise");
});

test("resolve: triage implement skips the repro gate (feature lane)", () => {
	const d = r.resolve({
		labels: ["bot:enhancement", "bot:triage"],
		event: "implement",
		actor: "maintainer",
	});
	assert.equal(d.to, "working");
	assert.equal(d.action, "investigate.implement");
});

test("resolve: terminals reopen, never dead", () => {
	for (const label of ["bot:done", "bot:declined"]) {
		const d = r.resolve({ labels: ["bot:bug", label], event: "reopen", actor: "maintainer" });
		assert.equal(d.to, "triage", `${label} reopens`);
	}
});

test("resolve: authorization is enforced per event", () => {
	const d = r.resolve({
		labels: ["bot:bug", "bot:blocked"],
		event: "implement",
		actor: "reporter",
	});
	assert.equal(d.kind, "noop", "reporter may not implement");
});

test("resolve: confirm allowed for reporter", () => {
	const d = r.resolve({
		labels: ["bot:bug", "bot:awaiting-feedback"],
		event: "confirm",
		actor: "reporter",
	});
	assert.equal(d.kind, "transition");
	assert.equal(d.to, "in_review");
});

test("resolve: unknown transition is a no-op, not an error", () => {
	const d = r.resolve({ labels: ["bot:bug", "bot:triage"], event: "confirm", actor: "maintainer" });
	assert.equal(d.kind, "noop");
});

test("resolve: status/help are read-only", () => {
	assert.equal(
		r.resolve({ labels: ["bot:bug", "bot:working"], event: "status", actor: "reporter" }).kind,
		"readonly",
	);
});

test("invariantProblems flags 0 or >1 of each dimension", () => {
	assert.deepEqual(r.invariantProblems(["bot:bug", "bot:blocked"]), []);
	assert.equal(r.invariantProblems(["bot:blocked"]).length, 1, "missing kind");
	assert.equal(r.invariantProblems(["bot:bug"]).length, 1, "missing state");
	assert.equal(
		r.invariantProblems(["bot:bug", "bot:blocked", "bot:working"]).length,
		1,
		"two states",
	);
});

test("resolveComment: bare feedback on a bot PR maps to revise", () => {
	const labels = ["bot:bug", "bot:in-review"];
	const d = r.resolveComment({
		labels,
		body: "@emdashbot the test name is wrong, rename it",
		actor: "maintainer",
		allowDefault: true,
	});
	assert.equal(d.kind, "transition");
	assert.equal(d.to, "working");
	assert.equal(d.action, "investigate.revise");
	assert.equal(
		d.arg,
		"the test name is wrong, rename it",
		"whole comment becomes the feedback arg",
	);
});

test("resolveComment: explicit verb wins over the default", () => {
	const labels = ["bot:bug", "bot:in-review"];
	const d = r.resolveComment({
		labels,
		body: "@emdashbot take over",
		actor: "maintainer",
		allowDefault: true,
	});
	assert.equal(d.to, "human_owned");
});

test("resolveComment: the @emdashbot mention is still required", () => {
	const labels = ["bot:bug", "bot:in-review"];
	const d = r.resolveComment({
		labels,
		body: "the test name is wrong",
		actor: "maintainer",
		allowDefault: true,
	});
	assert.equal(d.kind, "noop", "no mention -> inert even on a bot PR");
	assert.match(d.reason, MENTION_TEXT_RE);
});

test("resolveComment: free text in blocked routes to the classifier with safe candidates", () => {
	const labels = ["bot:bug", "bot:blocked"];
	const d = r.resolveComment({
		labels,
		body: "@emdashbot please try fixing it in the loader",
		actor: "maintainer",
		allowDefault: false,
	});
	assert.equal(d.kind, "classify");
	assert.equal(d.state, "blocked");
	const events = new Set(d.commands.map((c) => c.event));
	assert.ok(events.has("implement"));
	assert.ok(!events.has("decline"), "destructive excluded from classifier candidates");
	assert.equal(d.text, "please try fixing it in the loader");
});

test("resolveComment: whitespace-only mention renders status, not a classifier call", () => {
	// `@emdashbot   ` (mention + trailing whitespace only) is parsed as a
	// mention with empty body; route to readonly instead of the classifier so it
	// doesn't fail minLength(1) and silently return `none`.
	const d = r.resolveComment({
		labels: ["bot:bug", "bot:blocked"],
		body: "@emdashbot   ",
		actor: "maintainer",
		allowDefault: false,
	});
	assert.equal(d.kind, "readonly", "empty mention -> readonly, never reaches the classifier");
	assert.equal(d.state, "blocked");
});

test("resolveComment: bare destructive verb still fires deterministically", () => {
	const labels = ["bot:bug", "bot:blocked"];
	const d = r.resolveComment({
		labels,
		body: "@emdashbot decline",
		actor: "maintainer",
		allowDefault: false,
	});
	assert.equal(d.kind, "transition");
	assert.equal(d.to, "declined");
});

test("outcomeFromResult maps the agent's flat result to an agent.* event", () => {
	assert.equal(r.outcomeFromResult({ ok: false }), "agent.failed");
	assert.equal(r.outcomeFromResult({ ok: true, result: null }), "agent.failed");
	assert.equal(r.outcomeFromResult({ ok: true, result: { skipped: true } }), "agent.skipped");
	assert.equal(
		r.outcomeFromResult({ ok: true, result: { skipped: false, verdict: "intended-behavior" } }),
		"agent.by_design",
	);
	assert.equal(
		r.outcomeFromResult({
			ok: true,
			result: { skipped: false, reproduced: false, verdict: "bug" },
		}),
		"agent.not_reproduced",
	);
	assert.equal(
		r.outcomeFromResult({ ok: true, result: { reproduced: true, fixed: true, verdict: "bug" } }),
		"agent.fix_ready",
	);
	assert.equal(
		r.outcomeFromResult({ ok: true, result: { reproduced: true, fixed: false, verdict: "bug" } }),
		"agent.reproduced",
	);
});

test("outcomeFromResult feeds resolve to advance the machine end-to-end", () => {
	// fix_ready from working -> awaiting_feedback (the executor's happy path).
	const event = r.outcomeFromResult({ ok: true, result: { reproduced: true, fixed: true } });
	const d = r.resolve({ labels: ["bot:bug", "bot:working"], event, actor: "system" });
	assert.equal(d.to, "awaiting_feedback");
	// fix_ready does NOT open a PR; the executor pushes the branch and the
	// orchestrator asks the reporter. The PR opens on `confirm`.
	assert.equal(d.action, null);
});

test("replyFooter lists the offered commands for the state", () => {
	const footer = r.replyFooter("blocked");
	assert.match(footer, FOOTER_IMPLEMENT_RE);
	assert.match(footer, FOOTER_DECLINE_RE);
});
