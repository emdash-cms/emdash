import {
	bash,
	defineAgent,
	defineTool,
	registerApiProvider,
	registerProvider,
} from "@flue/runtime";
import { getCloudflareAIBindingApiProvider } from "@flue/runtime/cloudflare/internal";
import {
	Bash,
	InMemoryFs,
	bashFactoryToSessionEnv,
	createFlueContext,
	resetProviderRuntime,
	resolveModel,
} from "@flue/runtime/internal";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createAiPayloadGuard,
	FLUE_COMPACTION_SYSTEM_PROMPT,
	summarizeAiPayload,
} from "../.flue/lib/ai-payload-budget.js";
import { REVIEW_COMPACTION, REVIEW_MODEL_CONTEXT_TOKENS } from "../.flue/lib/review-compaction.js";
import { reviewResultSchema } from "../.flue/lib/review-schema.js";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";
const FINDING = "Finding retained: stale authorization check in packages/core/src/example.ts.";
const TOOL_RESULT_BYTES = [
	232_914, 186_294, 164_339, 150_000, 130_000, 116_082, 90_000, 80_000,
] as const;

interface ModelMessage {
	readonly role?: string;
	readonly content?: string | ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
}

function sse(chunks: unknown[]): Response {
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function usageFor(inputs: Record<string, unknown>) {
	const promptTokens = Math.ceil(summarizeAiPayload(inputs).totalBytes / 4);
	return {
		prompt_tokens: promptTokens,
		completion_tokens: 32,
		total_tokens: promptTokens + 32,
	};
}

function toolCallResponse(
	inputs: Record<string, unknown>,
	name: string,
	args: Record<string, unknown>,
	id: string,
): Response {
	return sse([
		{
			id,
			model: MODEL,
			choices: [
				{
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id,
								type: "function",
								function: { name, arguments: JSON.stringify(args) },
							},
						],
					},
				},
			],
		},
		{
			id,
			model: MODEL,
			choices: [{ delta: {}, finish_reason: "tool_calls" }],
			usage: usageFor(inputs),
		},
	]);
}

function textResponse(inputs: Record<string, unknown>, text: string, id: string): Response {
	return sse([
		{
			id,
			model: MODEL,
			choices: [{ delta: { role: "assistant", content: text } }],
		},
		{
			id,
			model: MODEL,
			choices: [{ delta: {}, finish_reason: "stop" }],
			usage: usageFor(inputs),
		},
	]);
}

function serializedMessages(inputs: Record<string, unknown>): string {
	const messages = Array.isArray(inputs.messages) ? (inputs.messages as ModelMessage[]) : [];
	return messages
		.flatMap((message) => {
			if (typeof message.content === "string") return [message.content];
			return (message.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "");
		})
		.join("\n");
}

describe("review conversation compaction", () => {
	afterEach(() => resetProviderRuntime());

	it("compacts a PR 3184-shaped tool history and continues to a structured result", async () => {
		const payloads: Record<string, unknown>[] = [];
		const reports = vi.fn();
		let toolCallIndex = 0;
		let compactionCalls = 0;
		let finishSawFinding = false;
		let finishSawRecentContext = false;
		let observedCompactionSystemPrompt: string | undefined;
		let requestIndex = 0;
		const executedChunks: number[] = [];
		const reviewResult = {
			verdict: "comment" as const,
			summary: "The review completed after retaining the earlier authorization finding.",
			findings: [
				{
					path: "packages/core/src/example.ts",
					line: 42,
					side: "RIGHT" as const,
					severity: "needs_fixing" as const,
					body: "The stale authorization check permits an unauthorized write.",
				},
			],
		};

		const binding = createAiPayloadGuard(
			{
				async run(_modelId, inputs) {
					payloads.push(inputs);
					requestIndex++;
					const messages = serializedMessages(inputs);

					if (messages.includes("context summarization assistant")) {
						compactionCalls++;
						const systemMessage = Array.isArray(inputs.messages)
							? (inputs.messages as ModelMessage[]).find((message) => message.role === "system")
							: undefined;
						observedCompactionSystemPrompt =
							typeof systemMessage?.content === "string" ? systemMessage.content : undefined;
						const retainedFinding = messages.includes(FINDING) ? FINDING : "Finding missing.";
						return textResponse(
							inputs,
							`## Goal\nReview the PR.\n\n## Progress\n### Done\n- [x] ${retainedFinding}\n\n## Next Steps\n1. Finish the review.`,
							`summary-${compactionCalls}`,
						);
					}

					if (toolCallIndex < TOOL_RESULT_BYTES.length) {
						const index = toolCallIndex++;
						return toolCallResponse(inputs, "inspect_chunk", { index }, `inspect-${index}`);
					}

					finishSawFinding = messages.includes(FINDING);
					finishSawRecentContext = messages.includes("Review artifact 7.");
					if (!finishSawFinding || !finishSawRecentContext) {
						return toolCallResponse(
							inputs,
							"give_up",
							{ reason: "Compaction lost required review context." },
							`give-up-${requestIndex}`,
						);
					}

					return toolCallResponse(inputs, "finish", reviewResult, `finish-${requestIndex}`);
				},
			},
			1024 * 1024,
			reports,
		);

		registerApiProvider(getCloudflareAIBindingApiProvider());
		registerProvider("cloudflare", {
			api: "cloudflare-ai-binding",
			binding,
			gateway: false,
		});
		expect(resolveModel(`cloudflare/${MODEL}`).contextWindow).toBe(REVIEW_MODEL_CONTEXT_TOKENS);

		const inspectChunk = defineTool({
			name: "inspect_chunk",
			description: "Inspect the next large review artifact.",
			input: v.object({ index: v.number() }),
			run({ input }) {
				const size = TOOL_RESULT_BYTES[input.index];
				if (size === undefined) throw new Error(`Unknown chunk ${input.index}`);
				executedChunks.push(input.index);
				const finding = input.index === 2 ? FINDING : `Review artifact ${input.index}.`;
				return `${finding}\n${"x".repeat(Math.max(0, size - finding.length - 1))}`;
			},
		});
		const agent = defineAgent(() => ({
			model: `cloudflare/${MODEL}`,
			compaction: REVIEW_COMPACTION,
			tools: [inspectChunk],
			sandbox: bash(() => new Bash({ fs: new InMemoryFs() })),
		}));
		const context = createFlueContext({
			id: "review-compaction-test",
			agentName: "review",
			env: {},
			agentConfig: { resolveModel },
			createDefaultEnv: () => bashFactoryToSessionEnv(() => new Bash({ fs: new InMemoryFs() })),
		});
		const events: Array<{
			type: string;
			isError?: boolean;
			messagesBefore?: number;
			messagesAfter?: number;
		}> = [];
		context.subscribeEvent((event) => events.push(event));
		const harness = await context.initializeRootHarness(agent);
		const session = await harness.session();

		const { data } = await session.prompt("Review this pull request in depth.", {
			result: reviewResultSchema,
		});

		expect(data).toEqual(reviewResult);
		expect(compactionCalls).toBeGreaterThan(0);
		expect(observedCompactionSystemPrompt).toBe(FLUE_COMPACTION_SYSTEM_PROMPT);
		expect(events).toContainEqual(expect.objectContaining({ type: "compaction", isError: false }));
		const completedCompaction = events.find(
			(event) => event.type === "compaction" && event.isError === false,
		);
		expect(completedCompaction?.messagesAfter).toBeLessThan(
			completedCompaction?.messagesBefore ?? 0,
		);
		expect(toolCallIndex).toBe(TOOL_RESULT_BYTES.length);
		expect(finishSawFinding).toBe(true);
		expect(finishSawRecentContext).toBe(true);
		expect(
			payloads.some((payload) =>
				serializedMessages(payload).includes('<compaction type="context_summary">'),
			),
		).toBe(true);

		const summaries = reports.mock.calls.map(([summary, _maxBytes, rejected]) => ({
			...summary,
			rejected,
		}));
		expect(summaries.some((summary) => summary.rejected)).toBe(true);
		expect(
			summaries
				.filter((summary) => summary.rejected)
				.every((summary) => summary.totalBytes < 1024 * 1024),
		).toBe(true);
		expect(Math.max(...summaries.map((summary) => summary.totalBytes))).toBeLessThan(1024 * 1024);
		expect(TOOL_RESULT_BYTES.reduce((total, size) => total + size, 0)).toBeGreaterThan(1024 * 1024);

		const replayedHarness = await context.initializeRootHarness(agent);
		const replayedSession = await replayedHarness.sessions.get();
		const replayed = await replayedSession.prompt("Return the persisted review result.", {
			result: reviewResultSchema,
		});
		expect(replayed.data).toEqual(reviewResult);
		expect(executedChunks).toEqual(TOOL_RESULT_BYTES.map((_size, index) => index));
	});
});
