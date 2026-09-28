import type { CloudflareAIBinding } from "@flue/runtime/cloudflare";

import { utf8ByteLength } from "./byte-budget.js";
import { REVIEW_COMPACTION_TRIGGER_TOKENS } from "./review-compaction.js";

export const MAX_AI_PAYLOAD_BYTES = 1024 * 1024;
export const COMPACT_AI_PAYLOAD_BYTES = 704 * 1024;
export const FLUE_COMPACTION_SYSTEM_PROMPT =
	"You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

export interface AiPayloadSummary {
	readonly totalBytes: number;
	readonly messageBytes: number;
	readonly toolBytes: number;
	readonly otherBytes: number;
	readonly messageCount: number;
	readonly toolCount: number;
	readonly messageBytesByRole: Readonly<Record<string, number>>;
	readonly largestMessage?: {
		readonly index: number;
		readonly role: string;
		readonly bytes: number;
	};
}

export type AiPayloadReporter = (
	summary: AiPayloadSummary,
	maxBytes: number,
	rejected: boolean,
) => void;

export class ModelPayloadTooLargeError extends Error {
	constructor(bytes: number, maxBytes: number) {
		super(
			`Review context is ${bytes} bytes, exceeding the ${maxBytes}-byte model-request budget. Narrow the review context or split the pull request.`,
		);
		this.name = "ModelPayloadTooLargeError";
	}
}

export function createAiPayloadGuard(
	binding: CloudflareAIBinding,
	maxBytes = MAX_AI_PAYLOAD_BYTES,
	report: AiPayloadReporter = reportAiPayload,
	compactBytes = Math.min(COMPACT_AI_PAYLOAD_BYTES, maxBytes),
): CloudflareAIBinding {
	return {
		async run(modelId, inputs, options) {
			const summary = summarizeAiPayload(inputs);
			const tooLarge = summary.totalBytes > maxBytes;
			const compactionRequired = !isCompactionPayload(inputs) && summary.totalBytes > compactBytes;
			const rejected = tooLarge || compactionRequired;
			try {
				report(summary, maxBytes, rejected);
			} catch {}
			if (tooLarge) throw new ModelPayloadTooLargeError(summary.totalBytes, maxBytes);
			if (compactionRequired) return compactionRequiredResponse(modelId);
			return binding.run(modelId, inputs, options);
		},
	};
}

function isCompactionPayload(inputs: unknown): boolean {
	if (!isRecord(inputs) || !Array.isArray(inputs.messages)) return false;
	return inputs.messages.some(
		(message) =>
			isRecord(message) &&
			message.role === "system" &&
			typeof message.content === "string" &&
			message.content === FLUE_COMPACTION_SYSTEM_PROMPT,
	);
}

function compactionRequiredResponse(modelId: string): Response {
	const chunk = {
		model: modelId,
		choices: [{ delta: {}, finish_reason: "stop" }],
		usage: {
			prompt_tokens: REVIEW_COMPACTION_TRIGGER_TOKENS + 1,
			completion_tokens: 0,
			total_tokens: REVIEW_COMPACTION_TRIGGER_TOKENS + 1,
		},
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

export function summarizeAiPayload(inputs: unknown): AiPayloadSummary {
	const totalBytes = serializedBytes(inputs);
	const record = isRecord(inputs) ? inputs : {};
	const messages: unknown[] = Array.isArray(record.messages) ? record.messages : [];
	const tools: unknown[] = Array.isArray(record.tools) ? record.tools : [];
	const messageBytes = Array.isArray(record.messages) ? serializedBytes(messages) : 0;
	const toolBytes = Array.isArray(record.tools) ? serializedBytes(tools) : 0;
	const messageBytesByRole: Record<string, number> = {};
	let largestMessage: AiPayloadSummary["largestMessage"];

	for (const [index, message] of messages.entries()) {
		const bytes = serializedBytes(message);
		const role = isRecord(message) && typeof message.role === "string" ? message.role : "unknown";
		messageBytesByRole[role] = (messageBytesByRole[role] ?? 0) + bytes;
		if (!largestMessage || bytes > largestMessage.bytes) largestMessage = { index, role, bytes };
	}

	return {
		totalBytes,
		messageBytes,
		toolBytes,
		otherBytes: Math.max(0, totalBytes - messageBytes - toolBytes),
		messageCount: messages.length,
		toolCount: tools.length,
		messageBytesByRole,
		...(largestMessage ? { largestMessage } : {}),
	};
}

function reportAiPayload(summary: AiPayloadSummary, maxBytes: number, rejected: boolean): void {
	console.log(
		JSON.stringify({
			message: "Workers AI request payload measured",
			...summary,
			maxBytes,
			rejected,
		}),
	);
}

function serializedBytes(value: unknown): number {
	return utf8ByteLength(JSON.stringify(value) ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
