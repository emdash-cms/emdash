import type { FlueObservation, LlmAssistantMessage, PromptUsage } from "@flue/runtime";

export const RUN_TRACE_TEXT_LIMIT = 49_152;
export const RUN_TRACE_PAGE_LIMIT = 200;
export const RUN_TRACE_EVENT_LIMIT = 5_000;

export type RunTraceTone = "active" | "success" | "failed" | "neutral";

export interface RunTraceEventInput {
	readonly key: string;
	readonly at: number;
	readonly kind:
		| "agent_start"
		| "agent_end"
		| "message"
		| "turn"
		| "tool_start"
		| "tool"
		| "task_start"
		| "task"
		| "compaction_start"
		| "compaction"
		| "operation"
		| "log"
		| "submission_queued"
		| "submission_running"
		| "submission_recovery"
		| "submission_settled";
	readonly title: string;
	readonly detail?: string | null;
	readonly tone: RunTraceTone;
	readonly turnId?: string;
	readonly toolCallId?: string;
	readonly durationMs?: number;
	readonly input?: string;
	readonly output?: string;
}

export interface PublicRunTraceEvent extends RunTraceEventInput {
	readonly id: number;
	readonly runId: string;
}

export interface PublicRunTraceSummary {
	readonly runId: string;
	readonly mode: "repro" | "implement" | "revise" | "diagnose" | "fix";
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly eventCount: number;
}

export interface PublicRunTracePage {
	readonly runs: readonly PublicRunTraceSummary[];
	readonly selectedRunId: string | null;
	readonly events: readonly PublicRunTraceEvent[];
	readonly nextBefore: number | null;
}

export function projectRunTraceObservation(event: FlueObservation): RunTraceEventInput | null {
	const base = {
		key: traceEventKey(event),
		at: Date.parse(event.timestamp),
	};
	switch (event.type) {
		case "agent_start":
			return { ...base, kind: "agent_start", title: "Agent started", tone: "active" };
		case "agent_end":
			return {
				...base,
				kind: "agent_end",
				title: "Agent finished",
				detail: `${event.messages.length} messages produced`,
				tone: "success",
			};
		case "message_end":
			return projectInputMessage(event.message, base, event.turnId);
		case "turn": {
			const output = event.response.output
				? serializeAssistantOutput(event.response.output)
				: serializeTraceValue(withoutStack(event.response.error));
			return {
				...base,
				kind: "turn",
				title: event.purpose === "agent" ? "Model turn" : "Compaction model turn",
				detail: turnDetail(
					event.request.requestedModel,
					event.response.finishReason,
					event.response.usage,
				),
				tone: event.isError ? "failed" : "active",
				turnId: event.turnId,
				durationMs: event.durationMs,
				...(output ? { output } : {}),
			};
		}
		case "tool_start":
			return {
				...base,
				kind: "tool_start",
				title: event.toolName,
				detail: event.origin ? `${event.origin} tool started` : "Tool started",
				tone: "active",
				...(event.turnId ? { turnId: event.turnId } : {}),
				toolCallId: event.toolCallId,
				...(event.args === undefined ? {} : { input: serializeTraceValue(event.args) }),
			};
		case "tool": {
			const result = event.isError
				? serializeTraceValue(withoutStack(event.errorInfo) ?? event.result)
				: serializeTraceValue(event.effectiveResult ?? event.result);
			return {
				...base,
				kind: "tool",
				title: event.toolName,
				detail: event.origin ? `${event.origin} tool finished` : "Tool finished",
				tone: event.isError ? "failed" : "success",
				...(event.turnId ? { turnId: event.turnId } : {}),
				toolCallId: event.toolCallId,
				durationMs: event.durationMs,
				...(result ? { output: result } : {}),
			};
		}
		case "task_start":
			return {
				...base,
				kind: "task_start",
				title: event.agent ? `Task · ${event.agent}` : "Task started",
				detail: event.cwd ?? null,
				tone: "active",
				input: truncateTraceText(event.prompt),
			};
		case "task":
			return {
				...base,
				kind: "task",
				title: event.agent ? `Task · ${event.agent}` : "Task finished",
				tone: event.isError ? "failed" : "success",
				durationMs: event.durationMs,
				...(event.result === undefined ? {} : { output: serializeTraceValue(event.result) }),
			};
		case "compaction_start":
			return {
				...base,
				kind: "compaction_start",
				title: "Context compaction started",
				detail: `${event.reason} · about ${event.estimatedTokens.toLocaleString()} tokens`,
				tone: "active",
			};
		case "compaction":
			return {
				...base,
				kind: "compaction",
				title: "Context compaction finished",
				detail: `${event.messagesBefore} → ${event.messagesAfter} messages`,
				tone: event.isError ? "failed" : "success",
				durationMs: event.durationMs,
				...(event.error === undefined ? {} : { output: serializeTraceValue(event.error) }),
			};
		case "operation":
			return {
				...base,
				kind: "operation",
				title: `${event.operationKind} operation`,
				tone: event.isError ? "failed" : "success",
				durationMs: event.durationMs,
				...(event.agentOutput === undefined
					? event.error === undefined
						? {}
						: { output: serializeTraceValue(event.error) }
					: { output: serializeTraceValue(event.agentOutput) }),
			};
		case "log":
			return {
				...base,
				kind: "log",
				title: event.message,
				detail: event.level,
				tone: event.level === "error" ? "failed" : event.level === "warn" ? "active" : "neutral",
				...(event.attributes === undefined
					? {}
					: { output: serializeTraceValue(event.attributes) }),
			};
		case "submission_queued":
			return {
				...base,
				kind: "submission_queued",
				title: "Submission queued",
				detail: event.kind,
				tone: "active",
			};
		case "submission_running":
			return {
				...base,
				kind: "submission_running",
				title: `Attempt ${event.attemptCount} started`,
				detail: `${event.kind} · ${event.maxAttempts} attempts available`,
				tone: "active",
			};
		case "submission_recovery":
			return {
				...base,
				kind: "submission_recovery",
				title: "Submission recovery",
				detail: `${event.operation.replaceAll("_", " ")} · ${event.outcome.replaceAll("_", " ")}`,
				tone: event.outcome === "terminated" ? "failed" : "active",
				...(event.error === undefined ? {} : { output: serializeTraceValue(event.error) }),
			};
		case "submission_settled":
			return {
				...base,
				kind: "submission_settled",
				title: `Submission ${event.outcome}`,
				tone: event.outcome === "completed" ? "success" : "failed",
				...(event.error === undefined ? {} : { output: serializeTraceValue(event.error) }),
			};
		default:
			return null;
	}
}

export function parseStoredRunTraceEvent(value: unknown): RunTraceEventInput | null {
	if (typeof value !== "object" || value === null) return null;
	if (!("key" in value) || typeof value.key !== "string") return null;
	if (!("at" in value) || typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
	if (!("kind" in value) || typeof value.kind !== "string") return null;
	if (!("title" in value) || typeof value.title !== "string") return null;
	if (!("tone" in value) || !isRunTraceTone(value.tone)) return null;
	if (!isRunTraceKind(value.kind)) return null;
	const detail = "detail" in value ? value.detail : undefined;
	const turnId = "turnId" in value ? value.turnId : undefined;
	const toolCallId = "toolCallId" in value ? value.toolCallId : undefined;
	const durationMs = "durationMs" in value ? value.durationMs : undefined;
	const input = "input" in value ? value.input : undefined;
	const output = "output" in value ? value.output : undefined;
	if (detail !== undefined && detail !== null && typeof detail !== "string") return null;
	if (turnId !== undefined && typeof turnId !== "string") return null;
	if (toolCallId !== undefined && typeof toolCallId !== "string") return null;
	if (durationMs !== undefined && (typeof durationMs !== "number" || !Number.isFinite(durationMs)))
		return null;
	if (input !== undefined && typeof input !== "string") return null;
	if (output !== undefined && typeof output !== "string") return null;
	return {
		key: value.key,
		at: value.at,
		kind: value.kind,
		title: value.title,
		tone: value.tone,
		...(typeof detail === "string" || detail === null ? { detail } : {}),
		...(typeof turnId === "string" ? { turnId } : {}),
		...(typeof toolCallId === "string" ? { toolCallId } : {}),
		...(typeof durationMs === "number" ? { durationMs } : {}),
		...(typeof input === "string" ? { input } : {}),
		...(typeof output === "string" ? { output } : {}),
	};
}

function projectInputMessage(
	message: unknown,
	base: Pick<RunTraceEventInput, "key" | "at">,
	turnId: string,
): RunTraceEventInput | null {
	if (typeof message !== "object" || message === null || !("role" in message)) return null;
	if (message.role === "assistant" || message.role === "toolResult") return null;
	return {
		...base,
		kind: "message",
		title: message.role === "signal" ? "Agent signal" : "Input message",
		tone: "neutral",
		turnId,
		input: serializeTraceValue(message) ?? "",
	};
}

function serializeAssistantOutput(message: LlmAssistantMessage): string | undefined {
	const sections: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") {
			if (part.text) sections.push(part.text);
			continue;
		}
		if (part.type !== "toolCall") continue;
		const args = serializeTraceValue(part.arguments);
		sections.push(`Tool call: ${part.name}${args ? `\n${args}` : ""}`);
	}
	return sections.length ? truncateTraceText(sections.join("\n\n")) : undefined;
}

function turnDetail(
	model: string,
	finishReason: string | undefined,
	usage: PromptUsage | undefined,
) {
	return [
		model,
		finishReason?.replaceAll(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(),
		usage ? `${usage.totalTokens.toLocaleString()} tokens` : null,
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
}

function serializeTraceValue(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return truncateTraceText(value);
	const seen = new WeakSet<object>();
	try {
		const json = JSON.stringify(
			value,
			(key, current: unknown) => {
				if (key === "stack") return undefined;
				if (typeof current === "bigint") return current.toString();
				if (typeof current !== "object" || current === null) return current;
				if (seen.has(current)) return "[circular]";
				seen.add(current);
				return current;
			},
			2,
		);
		return json === undefined ? undefined : truncateTraceText(json);
	} catch {
		return "[unserializable value]";
	}
}

function truncateTraceText(value: string): string {
	if (value.length <= RUN_TRACE_TEXT_LIMIT) return value;
	const suffix = `\n… [truncated ${value.length - RUN_TRACE_TEXT_LIMIT} additional characters]`;
	return `${value.slice(0, RUN_TRACE_TEXT_LIMIT - suffix.length)}${suffix}`;
}

function withoutStack(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "stack"));
}

function traceEventKey(event: FlueObservation): string {
	return [
		event.instanceId ?? "agent",
		event.submissionId ?? "none",
		event.eventIndex,
		event.type,
		event.timestamp,
	].join(":");
}

function isRunTraceTone(value: unknown): value is RunTraceTone {
	return value === "active" || value === "success" || value === "failed" || value === "neutral";
}

function isRunTraceKind(value: string): value is RunTraceEventInput["kind"] {
	return (
		value === "agent_start" ||
		value === "agent_end" ||
		value === "message" ||
		value === "turn" ||
		value === "tool_start" ||
		value === "tool" ||
		value === "task_start" ||
		value === "task" ||
		value === "compaction_start" ||
		value === "compaction" ||
		value === "operation" ||
		value === "log" ||
		value === "submission_queued" ||
		value === "submission_running" ||
		value === "submission_recovery" ||
		value === "submission_settled"
	);
}
