// Subscribe to Flue's event stream and log a compact one-line summary per
// event so production logs (wrangler tail) show the agent's turn-by-turn
// progress, not just the raw sandbox.exec lines. Imported once from app.ts.

import { observe } from "@flue/runtime";

let installed = false;

export function installAgentObserver(): void {
	if (installed) return;
	installed = true;

	observe((event) => {
		const runId = "runId" in event ? event.runId : undefined;
		const tag = runId ? `[flue/${runId.slice(-8)}]` : "[flue]";

		switch (event.type) {
			case "run_start":
				console.log(`${tag} run_start workflow=${event.workflowName}`);
				return;
			case "run_resume":
				console.log(`${tag} run_resume workflow=${event.workflowName}`);
				return;
			case "agent_start":
				console.log(`${tag} agent_start`);
				return;
			case "agent_end":
				console.log(`${tag} agent_end messages=${event.messages.length}`);
				return;
			case "turn_start":
				console.log(`${tag} turn_start turn=${event.turnId.slice(-8)} purpose=${event.purpose}`);
				return;
			case "turn_messages": {
				const msg = event.message;
				const text =
					msg.role === "assistant"
						? extractAssistantText(msg).slice(0, 200)
						: msg.role;
				console.log(
					`${tag} turn_msg turn=${event.turnId.slice(-8)} role=${msg.role} tools=${event.toolResults.length} text=${JSON.stringify(text)}`,
				);
				return;
			}
			case "tool_start":
				console.log(
					`${tag} tool_start ${event.toolName} id=${event.toolCallId.slice(-8)}`,
				);
				return;
			case "tool":
				console.log(
					`${tag} tool_end ${event.toolName} id=${event.toolCallId.slice(-8)} isError=${event.isError}`,
				);
				return;
			default:
				return;
		}
	});
}

function extractAssistantText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const m = message as { content?: unknown };
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		const parts: string[] = [];
		for (const part of m.content) {
			if (typeof part === "object" && part !== null && "text" in part && typeof (part as { text: unknown }).text === "string") {
				parts.push((part as { text: string }).text);
			}
		}
		return parts.join(" ");
	}
	return "";
}
