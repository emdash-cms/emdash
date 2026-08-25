import pullRequestTemplate from "../../../../.github/PULL_REQUEST_TEMPLATE.md?raw";
import {
	EVENTS,
	STATES,
	type CommandVerb,
	type EventId,
	type Kind,
	type StateId,
} from "./machine.js";
import {
	artifactsBranch,
	fixBranch,
	playgroundPreviewUrl,
	previewInstallCommand,
} from "./preview.js";
import type { Decision } from "./router.js";

export function shouldPostReadonlyReply(dryRun?: boolean): boolean {
	return dryRun !== true;
}

type HumanActor = "maintainer" | "reporter";

function renderCommand(command: EventId): string {
	const argument = EVENTS[command].arg ? ` <${EVENTS[command].arg}>` : "";
	return `\`@emdashbot ${command.replaceAll("_", " ")}${argument}\``;
}

function availableCommands(state: StateId | null, actor: HumanActor): CommandVerb[] {
	if (!state) return [];
	return STATES[state].offeredCommands.filter((command) => EVENTS[command].actors.includes(actor));
}

function renderAvailableCommands(state: StateId | null, actor: HumanActor): string {
	const commands = availableCommands(state, actor);
	if (commands.length === 0) {
		return "Use `@emdashbot status` to check the current state or `@emdashbot help` for command guidance.";
	}
	return `Available now: ${commands.map(renderCommand).join(" · ")}.`;
}

function renderHelpReply(state: StateId | null, actor: HumanActor): string {
	const commands = availableCommands(state, actor);
	const heading = state
		? `Commands available while this issue is in state \`${state}\`:`
		: "The issue has conflicting bot state labels. A maintainer can use `@emdashbot reset`.";
	const entries = commands.map(
		(command) => `- ${renderCommand(command)} — ${EVENTS[command].description}`,
	);
	return [
		heading,
		...(entries.length > 0 ? ["", ...entries] : []),
		"",
		"Use `@emdashbot status` to show the current state. Commands with an argument accept text after the verb.",
	].join("\n");
}

export function renderCommandFeedback(
	state: StateId | null,
	event: EventId | null,
	actor: HumanActor,
): string {
	const command = event ? renderCommand(event) : null;
	const metadata = event ? EVENTS[event] : null;
	const alternatives = renderAvailableCommands(state, actor);
	if (command && metadata && !metadata.actors.includes(actor)) {
		return `${command} can only be used by a maintainer.\n\n${alternatives}`;
	}
	if (!state) {
		return `I can't act while this issue has conflicting bot state labels. A maintainer can use \`@emdashbot reset\`.\n\n${alternatives}`;
	}
	if (command) {
		return `${command} isn't available while this issue is in state \`${state}\`.\n\n${alternatives}`;
	}
	return `I couldn't map that request to an action while this issue is in state \`${state}\`.\n\n${alternatives}`;
}

export function renderReadonlyReply(
	state: StateId | null,
	event: "status" | "help" = "status",
	actor: HumanActor = "maintainer",
): string {
	if (event === "help") return renderHelpReply(state, actor);
	switch (state) {
		case "unmanaged":
		case null:
		case "triage":
			return "Not currently working on this. Try `@emdashbot investigate <directive>` to diagnose a bug, `@emdashbot fix <directive>` for a direct bug fix, `@emdashbot implement <directive>` for another change, or `@emdashbot decline`.";
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
			return "My last attempt failed. A maintainer can `@emdashbot resume` if it saved a timeout checkpoint, start a fresh `@emdashbot retry`, or take it over.";
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
		? `@${input.reporterLogin} could you try this? Reply \`@emdashbot confirm\` if it works as requested, or \`@emdashbot reject <details>\` if it does not.`
		: "Could the reporter please try this? Reply `@emdashbot confirm` if it works as requested, or `@emdashbot reject <details>` if it does not.";
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
		"Or try the candidate in a ready-to-use playground:",
		"",
		`[Open the playground preview](${playgroundPreviewUrl(input.issueNumber)})`,
		"",
		...(shots.length > 0 ? ["**Screenshots:**", "", shots.join("\n\n"), ""] : []),
		reporterAsk,
		"",
		"<sub>Maintainers can use the same commands on the reporter's behalf. Confirmation opens a draft PR; rejection reaps the branch for revision.</sub>",
		"",
		`Fix branch: \`${fixBranch(input.issueNumber)}\` · Artifacts branch: \`${artifactsBranch(input.issueNumber)}\``,
	]
		.filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
		.join("\n");
}

export interface PullRequestCopy {
	readonly title: string;
	readonly description: string;
}

const TYPE_SECTION_HEADING_RE = /^## Type of change\b/im;
const BUG_FIX_CHECKBOX_RE = /^- \[ ] Bug fix\b(.*)$/im;
const FEATURE_CHECKBOX_RE = /^- \[ ] Feature\b(.*)$/im;
const AI_DISCLOSURE_CHECKBOX_RE = /^- \[ ] This PR includes AI-generated code\b.*$/im;

export function fillPullRequestTemplate(template: string, kind: Kind): string {
	const typeSectionStart = template.search(TYPE_SECTION_HEADING_RE);
	if (typeSectionStart === -1) throw new Error("pull request template is missing its type section");
	const typeCheckbox = kind === "bug" ? BUG_FIX_CHECKBOX_RE : FEATURE_CHECKBOX_RE;
	const typeLabel = kind === "bug" ? "Bug fix" : "Feature";
	const templateBody = template.slice(typeSectionStart);
	if (!typeCheckbox.test(templateBody)) {
		throw new Error(`pull request template is missing its ${typeLabel} checkbox`);
	}
	if (!AI_DISCLOSURE_CHECKBOX_RE.test(templateBody)) {
		throw new Error("pull request template is missing its AI disclosure checkbox");
	}
	return templateBody
		.replace(typeCheckbox, `- [x] ${typeLabel}$1`)
		.replace(
			AI_DISCLOSURE_CHECKBOX_RE,
			"- [x] This PR includes AI-generated code — model/tool: emdashbot + Kimi K2.7 Code",
		)
		.trim();
}

/**
 * Body for the draft PR opened when the reporter confirms the change. References
 * the issue (so merging closes it), points at the preview the reporter just
 * verified, and fills the repository's pull request template.
 */
export function renderDraftPrBody(input: {
	issueNumber: number;
	kind: Kind;
	description: string;
	previewPackage?: string;
}): string {
	const completedTemplate = fillPullRequestTemplate(pullRequestTemplate, input.kind);
	return [
		"## What does this PR do?",
		"",
		input.description.trim(),
		"",
		`Closes #${input.issueNumber}.`,
		"",
		"A candidate change the reporter confirmed against their own site via the preview build:",
		"",
		"```bash",
		previewInstallCommand(input.issueNumber, input.previewPackage),
		"```",
		"",
		"<sub>Opened automatically by emdashbot as a draft. A maintainer must review before merge.</sub>",
		"",
		completedTemplate,
	].join("\n");
}

export function renderPullRequestTitle(issueNumber: number, kind: Kind): string {
	return `${kind === "bug" ? "Fix" : "Implement"} #${issueNumber}`;
}
