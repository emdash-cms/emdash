import { describe, expect, test } from "vitest";

import {
	renderAgentComment,
	renderDraftPrBody,
	renderPreviewReadyAsk,
	shouldPostReadonlyReply,
} from "../../.flue/lib/comments.js";
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

describe("renderPreviewReadyAsk", () => {
	function ask(overrides: Partial<Parameters<typeof renderPreviewReadyAsk>[0]> = {}): string {
		return renderPreviewReadyAsk({
			owner: "emdash-cms",
			repo: "emdash",
			issueNumber: 77,
			at: "2026-08-08T00:00:00Z",
			notes: "Root cause: the loader drops the locale.",
			reporterLogin: "alice",
			...overrides,
		});
	}

	test("carries the bot-ask marker, full-ref install URL, notes, and reporter ask", () => {
		const body = ask();
		expect(body).toContain("<!-- bot-ask: 2026-08-08T00:00:00Z -->");
		expect(body).toContain("npm i https://pkg.pr.new/emdash@bot/fix-77");
		expect(body).toContain("Root cause: the loader drops the locale.");
		expect(body).toContain("@alice");
		expect(body).toContain("`bot/fix-77`");
		expect(body).toContain("`bot/artifacts-77`");
	});

	test("falls back to a generic ask when the reporter login is unknown", () => {
		const body = ask({ reporterLogin: null });
		expect(body).not.toContain("could you try this");
		expect(body).toContain("Could the reporter please try this");
	});

	test("renders screenshots from the artifacts branch with escaped alt text", () => {
		const body = ask({
			screenshots: [{ filename: "step-1.png", description: "broken [state] (here)" }],
		});
		expect(body).toContain(
			"https://raw.githubusercontent.com/emdash-cms/emdash/bot/artifacts-77/.bot-artifacts/step-1.png",
		);
		expect(body).toContain("broken \\[state\\] \\(here\\)");
	});

	test("drops screenshots whose filename could inject a URL or traverse paths", () => {
		const body = ask({
			screenshots: [
				{ filename: "../../etc/passwd", description: "traversal" },
				{ filename: "ok.png", description: "kept" },
			],
		});
		expect(body).not.toContain("etc/passwd");
		expect(body).toContain("/.bot-artifacts/ok.png");
	});

	test("omits the screenshots block entirely when there are none", () => {
		expect(ask({ screenshots: [] })).not.toContain("**Screenshots:**");
	});
});

describe("renderDraftPrBody", () => {
	test("closes the issue, links the verified preview, and flags review", () => {
		const body = renderDraftPrBody(77);
		expect(body).toContain("Closes #77.");
		expect(body).toContain("npm i https://pkg.pr.new/emdash@bot/fix-77");
		expect(body).toContain("regression test");
		expect(body).toContain("draft");
	});
});

describe("shouldPostReadonlyReply", () => {
	test("suppresses GitHub comments for dry runs", () => {
		expect(shouldPostReadonlyReply(true)).toBe(false);
		expect(shouldPostReadonlyReply(false)).toBe(true);
		expect(shouldPostReadonlyReply()).toBe(true);
	});
});
