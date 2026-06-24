// Unit tests for the pure router logic. Run: node --test .github/bot/router.cjs
const test = require("node:test");
const assert = require("node:assert/strict");

const r = require("./router.cjs");

test("currentState reads the single state label", () => {
	assert.equal(r.currentState(["bot:bug", "bot:blocked"]), "blocked");
	assert.equal(r.currentState(["bot:bug"]), null, "no state -> null");
	assert.equal(r.currentState(["bot:blocked", "bot:working"]), null, "two states -> null");
});

test("parseCommand parses verbs, args, and multi-word aliases", () => {
	assert.deepEqual(r.parseCommand("@emdashbot retry"), { event: "retry", arg: null });
	assert.deepEqual(r.parseCommand("@emdashbot take over"), { event: "take_over", arg: null });
	assert.deepEqual(r.parseCommand("@emdashbot hand back please"), { event: "hand_back", arg: "please" });
	assert.deepEqual(r.parseCommand("@emdashbot implement use a LEFT JOIN"), {
		event: "implement",
		arg: "use a LEFT JOIN",
	});
	assert.deepEqual(r.parseCommand("@emdashbot confirmed"), { event: "confirm", arg: null });
	assert.equal(r.parseCommand("please @emdashbot retry"), null, "must start the line");
	assert.equal(r.parseCommand("@emdashbot frobnicate"), null, "unknown verb -> null");
});

test("resolve: blocked accepts implement (kills the old skip sink)", () => {
	const d = r.resolve({ labels: ["bot:bug", "bot:blocked"], event: "implement", arg: "do X", actor: "maintainer" });
	assert.equal(d.kind, "transition");
	assert.equal(d.to, "working");
	assert.equal(d.action, "investigate.implement");
	assert.equal(d.addLabel, "bot:working");
	assert.ok(d.removeLabels.includes("bot:blocked"));
	assert.ok(!d.removeLabels.includes("bot:working"));
});

test("resolve: in_review accepts revise (PR feedback bridge)", () => {
	const d = r.resolve({ labels: ["bot:bug", "bot:in-review"], event: "revise", arg: "fix the test", actor: "maintainer" });
	assert.equal(d.to, "working");
	assert.equal(d.action, "investigate.revise");
});

test("resolve: triage implement skips the repro gate (feature lane)", () => {
	const d = r.resolve({ labels: ["bot:enhancement", "bot:triage"], event: "implement", actor: "maintainer" });
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
	const d = r.resolve({ labels: ["bot:bug", "bot:blocked"], event: "implement", actor: "reporter" });
	assert.equal(d.kind, "noop", "reporter may not implement");
});

test("resolve: confirm allowed for reporter", () => {
	const d = r.resolve({ labels: ["bot:bug", "bot:awaiting-feedback"], event: "confirm", actor: "reporter" });
	assert.equal(d.kind, "transition");
	assert.equal(d.to, "in_review");
});

test("resolve: unknown transition is a no-op, not an error", () => {
	const d = r.resolve({ labels: ["bot:bug", "bot:triage"], event: "confirm", actor: "maintainer" });
	assert.equal(d.kind, "noop");
});

test("resolve: status/help are read-only", () => {
	assert.equal(r.resolve({ labels: ["bot:bug", "bot:working"], event: "status", actor: "reporter" }).kind, "readonly");
});

test("invariantProblems flags 0 or >1 of each dimension", () => {
	assert.deepEqual(r.invariantProblems(["bot:bug", "bot:blocked"]), []);
	assert.equal(r.invariantProblems(["bot:blocked"]).length, 1, "missing kind");
	assert.equal(r.invariantProblems(["bot:bug"]).length, 1, "missing state");
	assert.equal(r.invariantProblems(["bot:bug", "bot:blocked", "bot:working"]).length, 1, "two states");
});

test("replyFooter lists the offered commands for the state", () => {
	const footer = r.replyFooter("blocked");
	assert.match(footer, /@emdashbot implement/);
	assert.match(footer, /@emdashbot decline/);
});
