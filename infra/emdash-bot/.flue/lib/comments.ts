import type { Kind, StateId } from "./machine.js";
import { artifactsBranch, fixBranch, previewInstallCommand } from "./preview.js";
import type { Decision } from "./router.js";

export function shouldPostReadonlyReply(dryRun?: boolean): boolean {
	return dryRun !== true;
}

export function renderReadonlyReply(state: StateId | null): string {
	switch (state) {
		case "unmanaged":
		case null:
		case "triage":
			return "Not currently working on this. Try `@emdashbot repro` (for a bug), `@emdashbot implement <directive>` (for a change), or `@emdashbot decline`.";
		case "working":
			return "Investigating now. I'll comment again when I have something to share.";
		case "blocked":
			return "I got stuck. A maintainer can `@emdashbot retry` or `@emdashbot implement <directive>` to give me a steer.";
		case "awaiting_feedback":
			return "Waiting for you to verify the preview from my last comment. Reply `@emdashbot confirm` if it works, or describe what's still wrong.";
		case "in_review":
			return "PR is open and under review.";
		case "human_owned":
			return "A maintainer has taken this over. Hand it back with `@emdashbot hand back`.";
		case "done":
			return "Done. Reopen with `@emdashbot reopen` if something else comes up.";
		case "declined":
			return "I declined this. Reopen with `@emdashbot reopen` if circumstances change.";
		case "failed":
			return "My last attempt failed. A maintainer can `@emdashbot retry` or take it over.";
		case "investigating":
			return "Investigating now (reproduce + diagnose). I'll report a verdict with evidence.";
		case "reproduced":
			return "Reproduced it -- diagnosis in my last comment. A maintainer can `@emdashbot fix` to try a fix, or `@emdashbot decline`.";
		case "diagnosed":
			return "Root cause identified (couldn't confirm with a reproduction here) -- diagnosis in my last comment. A maintainer can `@emdashbot fix` to try a fix, or `@emdashbot decline`.";
		case "not_reproduced":
			return "I couldn't reproduce this; transcript above. Reply with steps that fail for you, or a maintainer can `@emdashbot decline`.";
		case "needs_info":
			return "I need more to go on -- see my last comment for what's missing.";
		case "fixing":
			return "Building a candidate change.";
		case "preview_building":
			return "Building a preview so you can try the change.";
		case "awaiting_reporter":
			return "Try the preview from my last comment. Reply `@emdashbot confirm` if it works, or describe what needs to change.";
		default: {
			const _exhaustive: never = state;
			return `State: \`${String(_exhaustive)}\`.`;
		}
	}
}

/**
 * Decide what to post on a transition. For user-driven events (someone typed
 * `@emdashbot repro` etc.) we say nothing -- the verb is already on the
 * thread and echoing it adds noise. For agent.* events the comment IS the
 * agent's own summary, with a structural call-to-action appended where
 * appropriate. If the agent didn't return a summary, we skip the post.
 */
export function renderAgentComment(
	decision: Extract<Decision, { kind: "transition" }>,
	anchorNumber: number,
	agentSummary?: string,
	failure?: { runId?: string; failureStage?: string },
	previewPackage = "emdash",
): string {
	const summary = agentSummary?.trim();
	if (!decision.event.startsWith("agent.")) return "";
	if (!summary) return "";
	if (decision.event === "agent.failed") {
		const details = [
			failure?.failureStage ? `Failed stage: \`${failure.failureStage}\`` : "",
			failure?.runId ? `Run: \`${failure.runId}\`` : "",
		].filter(Boolean);
		return details.length > 0 ? `${summary}\n\n${details.join(" · ")}` : summary;
	}

	switch (decision.event) {
		case "agent.fix_ready":
			// The fix loop routes fix_ready into preview_building, where the preview
			// pipeline posts a deployed-preview link on preview.ready; a pkg.pr.new
			// install line is the legacy awaiting_feedback lane only.
			if (decision.to === "preview_building")
				return `${summary}\n\nBuilding a preview so you can try the change before I open a PR.`;
			return [
				summary,
				"",
				"Try it:",
				"",
				"```sh",
				previewInstallCommand(anchorNumber, previewPackage),
				"```",
				"",
				"Reply `@emdashbot confirm` if it works and I'll open the PR, or `@emdashbot revise <feedback>` to push changes.",
			].join("\n");
		case "agent.reproduced":
			if (decision.to === "reproduced")
				return `${summary}\n\nA maintainer can \`@emdashbot fix\` to try a fix, or \`@emdashbot decline\`.`;
			return `${summary}\n\nReply \`@emdashbot implement <directive>\` if you want me to take another swing with guidance.`;
		case "agent.diagnosed":
			return `${summary}\n\nI couldn't confirm this with a reproduction in my environment, but the diagnosis above is specific. A maintainer can \`@emdashbot fix\` to try a fix (the fix run verifies with a failing test first), or \`@emdashbot decline\`.`;
		case "agent.not_reproduced":
			return `${summary}\n\nReply with steps that fail for you, or close if it's no longer relevant.`;
		case "agent.needs_info":
			return `${summary}\n\nReply with the details above; a maintainer can \`@emdashbot investigate\` again once they arrive.`;
		default:
			return summary;
	}
}

/** A reproduction screenshot the fix agent pushed to the artifacts branch. */
export interface PreviewScreenshot {
	filename: string;
	description?: string;
}

// Defense in depth on the agent's structured output: only render screenshots
// whose filename is a plain basename (no path traversal, no URL injection), and
// escape the markdown metacharacters in the alt text so a description can't
// break out of the image span.
const SCREENSHOT_FILENAME_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const MD_ESCAPE_RE = /([\\[\]()])/g;

function mdEscape(text: string): string {
	return text.replace(MD_ESCAPE_RE, "\\$1");
}

/**
 * Compose the ask comment posted when a candidate change's preview has published.
 * The reporter verifies the change against their own site via the pkg.pr.new
 * install command, then replies to confirm or reject.
 *
 * Shape mirrors the gen-1 ask: a hidden `bot-ask` marker (the reply-staleness
 * anchor), the investigation notes, the full-ref install command, the
 * reproduction screenshots served from the artifacts branch, and the reporter
 * ask. Unlike gen-1 there is no "the preview may 404, retry" caveat -- the DO
 * polled pkg.pr.new to a 200 before posting this, so the URL already resolves.
 */
export function renderPreviewReadyAsk(input: {
	owner: string;
	repo: string;
	issueNumber: number;
	previewPackage?: string;
	at: string;
	notes?: string | null;
	screenshots?: readonly PreviewScreenshot[];
	reporterLogin?: string | null;
}): string {
	const shots = (input.screenshots ?? [])
		.filter((shot) => SCREENSHOT_FILENAME_RE.test(shot.filename))
		.map(
			(shot) =>
				`![${mdEscape(shot.description ?? shot.filename)}](https://raw.githubusercontent.com/${input.owner}/${input.repo}/${artifactsBranch(input.issueNumber)}/.bot-artifacts/${shot.filename})`,
		);
	const reporterAsk = input.reporterLogin
		? `@${input.reporterLogin} could you try this and reply here with whether it works as requested? A simple "yes" or "no" is enough.`
		: "Could the reporter please try this and reply with whether it works as requested?";
	return [
		`<!-- bot-ask: ${input.at} -->`,
		"A candidate change is ready to preview.",
		"",
		input.notes?.trim() ?? "",
		"",
		"Try the change against your own site:",
		"",
		"```bash",
		previewInstallCommand(input.issueNumber, input.previewPackage),
		"```",
		"",
		...(shots.length > 0 ? ["**Screenshots:**", "", shots.join("\n\n"), ""] : []),
		reporterAsk,
		"",
		"<sub>Maintainers can act on the reporter's behalf: `@emdashbot confirm` to accept the change and open a draft PR, or `@emdashbot reject` (with details) to reap the branch and revise.</sub>",
		"",
		`Fix branch: \`${fixBranch(input.issueNumber)}\` · Artifacts branch: \`${artifactsBranch(input.issueNumber)}\``,
	]
		.filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
		.join("\n");
}

/**
 * Body for the draft PR opened when the reporter confirms the change. References
 * the issue (so merging closes it), points at the preview the reporter just
 * verified, and flags that a maintainer must review before merge.
 */
export function renderDraftPrBody(issueNumber: number, previewPackage?: string): string {
	return [
		`Closes #${issueNumber}.`,
		"",
		"A candidate change the reporter confirmed against their own site via the preview build:",
		"",
		"```bash",
		previewInstallCommand(issueNumber, previewPackage),
		"```",
		"",
		"Review the candidate diff and its verification before merging.",
		"",
		"<sub>Opened automatically by emdashbot as a draft. A maintainer must review before merge.</sub>",
	].join("\n");
}

export function renderPullRequestTitle(issueNumber: number, kind: Kind): string {
	return `${kind === "bug" ? "Fix" : "Implement"} #${issueNumber}`;
}
