import type { FlueObservation } from "@flue/runtime";
import { describe, expect, test } from "vitest";

import { projectRunTraceObservation, RUN_TRACE_TEXT_LIMIT } from "../../.flue/lib/run-trace.js";

const envelope = {
	v: 3,
	eventIndex: 12,
	timestamp: "2026-08-19T10:00:00.000Z",
	instanceId: "investigate-1623-run-abc",
	submissionId: "submission-1",
} as const;

describe("public run traces", () => {
	test("projects each completed model turn without exposing reasoning blocks", () => {
		const event = {
			...envelope,
			type: "turn",
			turnId: "turn-1",
			purpose: "agent",
			durationMs: 1_234,
			request: {
				providerId: "workers-ai",
				providerName: "cloudflare",
				requestedModel: "deepseek-v4",
				api: "responses",
			},
			response: {
				finishReason: "toolUse",
				usage: {
					input: 100,
					output: 25,
					cacheRead: 50,
					cacheWrite: 0,
					totalTokens: 175,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				output: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private chain of thought" },
						{ type: "text", text: "I will inspect the bridge implementation." },
						{
							type: "toolCall",
							id: "call-1",
							name: "read_file",
							arguments: { path: "packages/cloudflare/src/sandbox/bridge.ts" },
						},
					],
				},
			},
			isError: false,
		} satisfies FlueObservation;

		const projected = projectRunTraceObservation(event);

		expect(projected).toMatchObject({
			kind: "turn",
			title: "Model turn",
			turnId: "turn-1",
			durationMs: 1_234,
			tone: "active",
		});
		expect(projected?.detail).toContain("deepseek-v4");
		expect(projected?.detail).toContain("175 tokens");
		expect(projected?.output).toContain("I will inspect the bridge implementation.");
		expect(projected?.output).toContain("read_file");
		expect(projected?.output).toContain("packages/cloudflare/src/sandbox/bridge.ts");
		expect(projected?.output).not.toContain("private chain of thought");
	});

	test("records complete tool arguments and the model-visible result", () => {
		const started = projectRunTraceObservation({
			...envelope,
			eventIndex: 13,
			type: "tool_start",
			turnId: "turn-1",
			toolName: "exec",
			toolCallId: "call-1",
			args: { command: "pnpm --filter @emdash-cms/cloudflare test" },
			origin: "model",
		});
		const finished = projectRunTraceObservation({
			...envelope,
			eventIndex: 14,
			type: "tool",
			turnId: "turn-1",
			toolName: "exec",
			toolCallId: "call-1",
			isError: false,
			durationMs: 3_500,
			result: { content: [{ type: "text", text: "internal shape" }] },
			effectiveResult: "exit 0\n334 tests passed",
			origin: "model",
		});

		expect(started).toMatchObject({
			kind: "tool_start",
			title: "exec",
			toolCallId: "call-1",
		});
		expect(started?.input).toContain("pnpm --filter @emdash-cms/cloudflare test");
		expect(finished).toMatchObject({
			kind: "tool",
			title: "exec",
			toolCallId: "call-1",
			durationMs: 3_500,
			tone: "success",
			output: "exit 0\n334 tests passed",
		});
		expect(finished?.output).not.toContain("internal shape");
	});

	test("bounds a single oversized payload without dropping the event", () => {
		const projected = projectRunTraceObservation({
			...envelope,
			type: "tool",
			toolName: "read_file",
			toolCallId: "call-large",
			isError: false,
			durationMs: 10,
			effectiveResult: "x".repeat(RUN_TRACE_TEXT_LIMIT + 100),
		});

		expect(projected?.output?.length).toBeLessThanOrEqual(RUN_TRACE_TEXT_LIMIT);
		expect(projected?.output).toContain("truncated");
	});
});
