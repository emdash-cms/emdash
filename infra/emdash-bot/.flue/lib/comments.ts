import type { StateId } from "./machine.js";
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
): string {
	const summary = agentSummary?.trim();
	if (!decision.event.startsWith("agent.")) return "";
	if (!summary) return "";

	switch (decision.event) {
		case "agent.fix_ready":
			return [
				summary,
				"",
				"Try it:",
				"",
				"```sh",
				`pnpm add https://pkg.pr.new/emdash-cms/emdash@bot/fix-${anchorNumber}`,
				"```",
				"",
				"Reply `@emdashbot confirm` if it works and I'll open the PR, or `@emdashbot revise <feedback>` to push changes.",
			].join("\n");
		case "agent.reproduced":
			return `${summary}\n\nReply \`@emdashbot implement <directive>\` if you want me to take another swing with guidance.`;
		case "agent.not_reproduced":
			return `${summary}\n\nReply with steps that fail for you, or close if it's no longer relevant.`;
		default:
			return summary;
	}
}
