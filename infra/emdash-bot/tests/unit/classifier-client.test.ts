import { afterEach, describe, expect, test, vi } from "vitest";

import {
	classifyComment,
	type ClassifierAi,
	resolveClassification,
} from "../../.flue/lib/classifier-client.js";
import { classifierCommands } from "../../.flue/lib/router.js";

const commands = classifierCommands("blocked");
const input = {
	issueNumber: 42,
	state: "blocked" as const,
	comment: "implement using your best judgement for the design",
};

function mockAi(output: Ai_Cf_Qwen_Qwen3_30B_A3B_Fp8_Output) {
	const run = vi.fn<ClassifierAi["run"]>().mockResolvedValue(output);
	return { ai: { run } satisfies ClassifierAi, run };
}

function toolCallResponse(argumentsJson: string): Ai_Cf_Qwen_Qwen3_30B_A3B_Fp8_Output {
	return {
		choices: [
			{
				message: {
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "call-1",
							type: "function",
							function: { name: "select_command", arguments: argumentsJson },
						},
					],
				},
			},
		],
	};
}

describe("classifyComment", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test("returns no-commands without running the model when the state offers none", async () => {
		const { ai, run } = mockAi(toolCallResponse("{}"));

		expect(await classifyComment(ai, { ...input, state: null })).toEqual({ kind: "no-commands" });
		expect(run).not.toHaveBeenCalled();
	});

	test("resolves the command from one model tool call", async () => {
		const event = commands.find((command) => command.event === "implement");
		expect(event).toBeDefined();
		if (!event) return;
		const { ai, run } = mockAi(
			toolCallResponse(
				JSON.stringify({
					event: event.event,
					arg: "using your best judgement for the design",
					reasoning: "the comment explicitly asks to implement",
				}),
			),
		);

		expect(await classifyComment(ai, input)).toEqual({
			kind: "event",
			event: event.event,
			arg: "using your best judgement for the design",
			reasoning: "the comment explicitly asks to implement",
		});
		expect(run).toHaveBeenCalledOnce();
	});

	test("returns an error when the model does not call the classifier tool", async () => {
		const { ai } = mockAi({ choices: [{ message: { role: "assistant", content: "retry" } }] });

		expect(await classifyComment(ai, input)).toEqual({
			kind: "error",
			error: "classifier returned no select_command tool call",
		});
	});

	test("returns an error when the tool arguments are not JSON", async () => {
		const { ai } = mockAi(toolCallResponse("not-json"));

		expect(await classifyComment(ai, input)).toEqual({
			kind: "error",
			error: "classifier returned invalid tool arguments",
		});
	});

	test("maps a rejected model request to an error result", async () => {
		const run = vi.fn<ClassifierAi["run"]>().mockRejectedValue(new Error("Workers AI unavailable"));

		expect(await classifyComment({ run }, input)).toEqual({
			kind: "error",
			error: "Workers AI unavailable",
		});
	});
});

describe("resolveClassification", () => {
	test("accepts resume when a failed run offers it", () => {
		const failedCommands = classifierCommands("failed");
		expect(
			resolveClassification(
				{
					event: "resume",
					arg: "continue from the saved work",
					reasoning: "The maintainer asks the previous run to continue",
				},
				failedCommands,
			),
		).toEqual({
			kind: "event",
			event: "resume",
			arg: "continue from the saved work",
			reasoning: "The maintainer asks the previous run to continue",
		});
	});

	test("rejects a missing structured result", () => {
		expect(resolveClassification(undefined, commands)).toEqual({
			kind: "error",
			error: "classifier returned no structured result",
		});
	});

	test("maps none without guessing an event", () => {
		expect(
			resolveClassification(
				{ event: "none", arg: null, reasoning: "The comment only asks a question" },
				commands,
			),
		).toEqual({ kind: "none", reasoning: "The comment only asks a question" });
	});

	test("rejects events outside the available command set", () => {
		expect(
			resolveClassification(
				{ event: "confirm", arg: null, reasoning: "The comment says confirm" },
				commands,
			),
		).toEqual({ kind: "error", error: 'classifier returned unknown event "confirm"' });
	});

	test("maps a known event and directive", () => {
		const event = commands[0];
		expect(event).toBeDefined();
		if (!event) return;
		expect(
			resolveClassification(
				{
					event: event.event,
					arg: "try SQLite",
					reasoning: "The comment asks for another attempt",
				},
				commands,
			),
		).toEqual({
			kind: "event",
			event: event.event,
			arg: "try SQLite",
			reasoning: "The comment asks for another attempt",
		});
	});
});
