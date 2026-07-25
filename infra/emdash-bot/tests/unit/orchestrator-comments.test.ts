import { describe, expect, test } from "vitest";

import { renderAgentComment, shouldPostReadonlyReply } from "../../.flue/lib/comments.js";
import type { Decision } from "../../.flue/lib/router.js";

function fixReadyDecision(): Extract<Decision, { kind: "transition" }> {
	return {
		kind: "transition",
		from: "working",
		to: "awaiting_feedback",
		action: null,
		addLabel: "bot:awaiting-feedback",
		addLabels: ["bot:awaiting-feedback"],
		removeLabels: ["bot:working"],
		event: "agent.fix_ready",
		arg: null,
	};
}

describe("renderAgentComment", () => {
	test("agent.fix_ready uses the canonical pkg.pr.new owner/repo URL", () => {
		const body = renderAgentComment(fixReadyDecision(), 1234, "Fixed the bug.");
		expect(body).toContain("pnpm add https://pkg.pr.new/emdash-cms/emdash@bot/fix-1234");
		expect(body).not.toContain("https://pkg.pr.new/emdash@bot/fix-");
	});
});

describe("shouldPostReadonlyReply", () => {
	test("suppresses GitHub comments for dry runs", () => {
		expect(shouldPostReadonlyReply(true)).toBe(false);
		expect(shouldPostReadonlyReply(false)).toBe(true);
		expect(shouldPostReadonlyReply()).toBe(true);
	});
});
