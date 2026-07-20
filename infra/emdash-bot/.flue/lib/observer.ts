// Subscribe to Flue's event stream and log a compact one-line summary per
// event so production logs (wrangler tail) show the agent's turn-by-turn
// progress, not just the raw sandbox.exec lines. Imported once from app.ts.

import { observe } from "@flue/runtime";

let installed = false;

export function installAgentObserver(): void {
	if (installed) return;
	installed = true;

	observe((event) => {
		const correlationId = event.submissionId ?? event.dispatchId ?? event.instanceId;
		const tag = correlationId ? `[flue/${correlationId.slice(-8)}]` : "[flue]";

		switch (event.type) {
			case "agent_start":
				console.log(`${tag} agent_start agent=${event.agentName ?? "unknown"}`);
				return;
			case "agent_end":
				console.log(`${tag} agent_end messages=${event.messages.length}`);
				return;
			case "turn_start":
				console.log(`${tag} turn_start turn=${event.turnId.slice(-8)} purpose=${event.purpose}`);
				return;
			case "turn_messages": {
				const msg = event.message;
				if (msg.role === "assistant") {
					const summary = summarizeAssistant(msg);
					console.log(`${tag} turn_msg turn=${event.turnId.slice(-8)} ${summary}`);
				} else {
					console.log(
						`${tag} turn_msg turn=${event.turnId.slice(-8)} role=${msg.role} tools=${event.toolResults.length}`,
					);
				}
				return;
			}
			case "tool_start":
				console.log(`${tag} tool_start ${event.toolName} id=${event.toolCallId.slice(-8)}`);
				return;
			case "tool":
				console.log(
					`${tag} tool_end ${event.toolName} id=${event.toolCallId.slice(-8)} isError=${event.isError}`,
				);
				return;
			case "submission_settled":
				console.log(`${tag} submission_settled outcome=${event.outcome}`);
				return;
			default:
				return;
		}
	});
}

function summarizeAssistant(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return `text=${JSON.stringify(content.slice(0, 200))}`;
	if (!Array.isArray(content)) return "";

	const texts: string[] = [];
	const thinks: string[] = [];
	const toolCalls: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null || !("type" in part)) continue;
		const type = part.type;
		if (typeof type !== "string") continue;
		if (type === "text" && "text" in part && typeof part.text === "string") {
			texts.push(part.text);
		} else if (type === "thinking" && "thinking" in part && typeof part.thinking === "string") {
			thinks.push(part.thinking);
		} else if (type === "tool_call" || type === "toolCall") {
			const name =
				"toolName" in part && typeof part.toolName === "string"
					? part.toolName
					: "name" in part && typeof part.name === "string"
						? part.name
						: undefined;
			if (name) toolCalls.push(name);
		}
	}
	const out: string[] = [];
	if (texts.length) out.push(`text=${JSON.stringify(texts.join(" ").slice(0, 240))}`);
	if (thinks.length) out.push(`thinking=${JSON.stringify(thinks.join(" ").slice(0, 240))}`);
	if (toolCalls.length) out.push(`tools=[${toolCalls.join(",")}]`);
	if (out.length === 0) out.push("(empty)");
	return out.join(" ");
}
