import { describe, expect, test } from "vitest";

import {
	fillPullRequestTemplate,
	renderAgentComment,
	renderCommandFeedback,
	renderDraftPrBody,
	renderPreviewReadyAsk,
	renderReadonlyReply,
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

function failedDecision(): Extract<Decision, { kind: "transition" }> {
	return {
		kind: "transition",
		from: "working",
		to: "failed",
		action: null,
		addLabel: "bot:failed",
		addLabels: ["bot:failed"],
		removeLabels: ["bot:working"],
		event: "agent.failed",
		arg: null,
	};
}

describe("renderAgentComment", () => {
	test("agent.fix_ready uses the default production preview package", () => {
		const body = renderAgentComment(fixReadyDecision(), 1234, "Fixed the bug.");
		expect(body).toContain("npm i https://pkg.pr.new/emdash@bot/fix-1234");
		expect(body).not.toContain("https://pkg.pr.new/emdash-cms/emdash@bot/fix-");
	});

	test("agent.fix_ready uses the configured staging preview package", () => {
		const body = renderAgentComment(
			fixReadyDecision(),
			1234,
			"Fixed the bug.",
			undefined,
			"owner/canary/package",
		);
		expect(body).toContain("npm i https://pkg.pr.new/owner/canary/package@bot/fix-1234");
		expect(body).not.toContain("https://pkg.pr.new/emdash-cms/emdash@bot/fix-1234");
	});

	test("failed comments identify the failed stage and durable run", () => {
		const body = renderAgentComment(failedDecision(), 1234, "Publication did not complete.", {
			runId: "run-abc",
			failureStage: "publication",
		});
		expect(body).toContain("Failed stage: `publication`");
		expect(body).toContain("Run: `run-abc`");
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
		expect(body).toContain("[Open the playground preview](https://bot-fix-77.try.emdashcms.com/)");
		expect(body).toContain("Root cause: the loader drops the locale.");
		expect(body).toContain("@alice");
		expect(body).toContain("`bot/fix-77`");
		expect(body).toContain("`bot/artifacts-77`");
		expect(body).toContain("`@emdashbot confirm`");
		expect(body).toContain("`@emdashbot reject <details>`");
		expect(body).not.toContain('A simple "yes" or "no" is enough.');
	});

	test("falls back to a generic ask when the reporter login is unknown", () => {
		const body = ask({ reporterLogin: null });
		expect(body).not.toContain("could you try this");
		expect(body).toContain("Could the reporter please try this");
	});

	test("uses the staging preview package supplied by the orchestrator", () => {
		const body = ask({ previewPackage: "owner/canary/canary-package" });
		expect(body).toContain("npm i https://pkg.pr.new/owner/canary/canary-package@bot/fix-77");
		expect(body).not.toContain("https://pkg.pr.new/emdash@bot/fix-77");
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

	test("does not describe a directed implementation as a reproduced bug", () => {
		const body = ask({ notes: "Added the requested export." });
		expect(body).toContain("candidate change");
		expect(body).not.toMatch(/reproduced|candidate fix/i);
	});
});

describe("renderDraftPrBody", () => {
	test("tolerates normal wording changes in the pull request template", () => {
		const template = [
			"## TYPE OF CHANGE",
			"",
			"- [ ] Bug fix (include a regression test)",
			"- [ ] Feature (link the approved discussion)",
			"",
			"## AI-generated code disclosure",
			"",
			"- [ ] This PR includes AI-generated code — model/tool: examples may change",
		].join("\n");

		const completed = fillPullRequestTemplate(template, "bug");
		expect(completed).toContain("- [x] Bug fix (include a regression test)");
		expect(completed).toContain("- [ ] Feature (link the approved discussion)");
		expect(completed).toContain(
			"- [x] This PR includes AI-generated code — model/tool: emdashbot + Kimi K2.7 Code",
		);
	});

	test("fills the GitHub PR template with the bot description and preview", () => {
		const body = renderDraftPrBody({
			issueNumber: 77,
			kind: "bug",
			description: "Preserves the requested locale when the loader resolves content.",
		});
		expect(body).toContain("## What does this PR do?");
		expect(body).toContain("Preserves the requested locale when the loader resolves content.");
		expect(body).toContain("Closes #77.");
		expect(body).toContain("npm i https://pkg.pr.new/emdash@bot/fix-77");
		expect(body).toContain("## Type of change");
		expect(body).toContain("- [x] Bug fix");
		expect(body).toContain("## Checklist");
		expect(body).toContain("## AI-generated code disclosure");
		expect(body).toContain("- [x] This PR includes AI-generated code");
		expect(body).toContain("## Screenshots / test output");
		expect(body).not.toContain("<!-- Describe the change");
	});
});

describe("shouldPostReadonlyReply", () => {
	test("uses change-neutral copy for the shared delivery states", () => {
		expect(renderReadonlyReply("fixing")).toBe("Building a candidate change.");
		expect(renderReadonlyReply("preview_building")).toBe(
			"Building a preview so you can try the change.",
		);
		expect(renderReadonlyReply("awaiting_reporter")).toContain("if it works");
	});

	test("suppresses GitHub comments for dry runs", () => {
		expect(shouldPostReadonlyReply(true)).toBe(false);
		expect(shouldPostReadonlyReply(false)).toBe(true);
		expect(shouldPostReadonlyReply()).toBe(true);
	});

	test("help lists the commands available to the actor in the current state", () => {
		const body = renderReadonlyReply("unmanaged", "help", "maintainer");
		expect(body).toContain("`@emdashbot fix <directive>`");
		expect(body).toContain("`@emdashbot implement <directive>`");
		expect(body).toContain("Build a candidate bug fix");
	});
});

describe("renderCommandFeedback", () => {
	test("explains an unavailable command and lists valid alternatives", () => {
		const body = renderCommandFeedback("unmanaged", "confirm", "maintainer");
		expect(body).toContain("`@emdashbot confirm` isn't available");
		expect(body).toContain("`unmanaged`");
		expect(body).toContain("`@emdashbot fix <directive>`");
		expect(body).toContain("`@emdashbot investigate <directive>`");
	});

	test("does not offer maintainer commands to a reporter", () => {
		const body = renderCommandFeedback("unmanaged", "investigate", "reporter");
		expect(body).toContain("can only be used by a maintainer");
		expect(body).not.toContain("Available now: `@emdashbot fix");
	});
});
