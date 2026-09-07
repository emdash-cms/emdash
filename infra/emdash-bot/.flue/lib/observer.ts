// Subscribe to Flue's event stream and log a compact one-line summary per
// event so production logs (wrangler tail) show the agent's turn-by-turn
// progress, not just the raw sandbox.exec lines. Imported once from app.ts.

import { observe } from "@flue/runtime";

import type { OrchestratorDO } from "./orchestrator.js";
import { projectRunTraceObservation } from "./run-trace.js";
import { withDeadline } from "./sandbox-deadline.js";

interface ObserverEnv extends Env {
	Orchestrator: DurableObjectNamespace<OrchestratorDO>;
}

const TRACE_WRITES = Symbol.for("emdash-bot.traceWrites");
const OBSERVER_INSTALLED = Symbol.for("emdash-bot.observerInstalled");
const TRACE_AGENT_ID_RE = /^investigate-(\d+)-(.+)$/;
const TRACE_FLUSH_TIMEOUT_MS = 2_000;

function traceWrites(): Map<string, Promise<void>> {
	const store = globalThis as typeof globalThis & { [TRACE_WRITES]?: Map<string, Promise<void>> };
	return (store[TRACE_WRITES] ??= new Map());
}

function claimObserverInstall(): boolean {
	const store = globalThis as typeof globalThis & { [OBSERVER_INSTALLED]?: boolean };
	if (store[OBSERVER_INSTALLED]) return false;
	store[OBSERVER_INSTALLED] = true;
	return true;
}

export function installAgentObserver(): void {
	if (!claimObserverInstall()) return;

	observe((event, context) => {
		const correlationId = event.submissionId ?? event.instanceId;
		const tag = correlationId ? `[flue/${correlationId.slice(-8)}]` : "[flue]";

		switch (event.type) {
			case "agent_start":
				console.log(`${tag} agent_start agent=${event.agentName ?? "unknown"}`);
				break;
			case "agent_end":
				console.log(`${tag} agent_end messages=${event.messages.length}`);
				break;
			case "turn_start":
				console.log(`${tag} turn_start turn=${event.turnId.slice(-8)} purpose=${event.purpose}`);
				break;
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
				break;
			}
			case "tool_start":
				console.log(`${tag} tool_start ${event.toolName} id=${event.toolCallId.slice(-8)}`);
				break;
			case "tool":
				console.log(
					`${tag} tool_end ${event.toolName} id=${event.toolCallId.slice(-8)} isError=${event.isError}`,
				);
				break;
			case "submission_settled":
				console.log(`${tag} submission_settled outcome=${event.outcome}`);
				break;
			default:
				break;
		}

		const target = traceTarget(context.id);
		const projected = target ? projectRunTraceObservation(event) : null;
		if (!target || !projected) return;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Flue exposes platform bindings through a generic event context.
		const { Orchestrator } = context.env as unknown as ObserverEnv;
		const writes = traceWrites();
		const previous = writes.get(context.id) ?? Promise.resolve();
		const next = previous.then(async () => {
			try {
				await Orchestrator.getByName(`issue-${target.issueNumber}`).recordRunTraceEvent({
					runId: target.runId,
					event: projected,
				});
			} catch (error) {
				console.warn("[flue] run trace write failed", {
					runId: target.runId,
					event: projected.kind,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return undefined;
		});
		writes.set(context.id, next);
		void next.then(() => {
			if (writes.get(context.id) === next) writes.delete(context.id);
			return undefined;
		});
		return next;
	});
}

export async function flushAgentTraceWrites(agentId: string): Promise<void> {
	const pending = traceWrites().get(agentId);
	if (!pending) return;
	try {
		await withDeadline(pending, TRACE_FLUSH_TIMEOUT_MS, "Run trace flush");
	} catch (error) {
		console.warn("[flue] run trace flush timed out", {
			agentId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function traceTarget(agentId: string): { issueNumber: number; runId: string } | null {
	const match = TRACE_AGENT_ID_RE.exec(agentId);
	if (!match?.[1] || !match[2]) return null;
	const issueNumber = Number(match[1]);
	if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
	return { issueNumber, runId: match[2] };
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
