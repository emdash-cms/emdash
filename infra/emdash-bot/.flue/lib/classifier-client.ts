import * as v from "valibot";

import { classifyResultSchema } from "../agents/classify-command.js";
import type { EventId, StateId } from "./machine.js";
import { classifierCommands } from "./router.js";
import { withDeadline } from "./sandbox-deadline.js";

const CLASSIFY_TIMEOUT_MS = 10_000;
const CLASSIFIER_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8" as const;

export interface ClassifierAi {
	run(
		model: typeof CLASSIFIER_MODEL,
		inputs: Ai_Cf_Qwen_Qwen3_30B_A3B_Fp8_Messages,
		options?: AiOptions,
	): Promise<Ai_Cf_Qwen_Qwen3_30B_A3B_Fp8_Output>;
}

export interface ClassifierInput {
	issueNumber: number;
	state: StateId | null;
	comment: string;
	/** Bot's last reply, for the model's context. Optional. */
	botContext?: string;
}

export type ClassifyResult =
	| { kind: "none"; reasoning: string }
	| { kind: "event"; event: EventId; arg: string | null; reasoning: string }
	| { kind: "no-commands" }
	| { kind: "error"; error: string };

interface ClassifyResponse {
	event: string;
	arg?: string | null;
	reasoning?: string;
}

export async function classifyComment(
	ai: ClassifierAi,
	input: ClassifierInput,
): Promise<ClassifyResult> {
	const commands = classifierCommands(input.state);
	if (commands.length === 0) return { kind: "no-commands" };

	let response: Ai_Cf_Qwen_Qwen3_30B_A3B_Fp8_Output;
	try {
		response = await withDeadline(
			ai.run(CLASSIFIER_MODEL, classifierRequest(input, commands), {
				signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
			}),
			CLASSIFY_TIMEOUT_MS,
			"Classifier request",
		);
	} catch (err) {
		return { kind: "error", error: errorMessage(err) };
	}

	const argumentsJson = selectCommandArguments(response);
	if (argumentsJson === null) {
		return { kind: "error", error: "classifier returned no select_command tool call" };
	}
	let result: unknown;
	try {
		result = JSON.parse(argumentsJson);
	} catch {
		return { kind: "error", error: "classifier returned invalid tool arguments" };
	}
	return resolveClassification(result, commands);
}

function classifierRequest(
	input: ClassifierInput,
	commands: ReturnType<typeof classifierCommands>,
): Ai_Cf_Qwen_Qwen3_30B_A3B_Fp8_Messages {
	const actionList = commands
		.map(
			(command) =>
				`- ${command.event}: ${command.description}${command.arg ? ` Set arg to the ${command.arg}.` : ""}`,
		)
		.join("\n");
	return {
		messages: [
			{
				role: "system",
				content: [
					"Route the comment to exactly one available action.",
					"The state only limits the available list; every listed action is valid.",
					"Call select_command exactly once. Prefer none over guessing. Do not answer with prose.",
				].join(" "),
			},
			{
				role: "user",
				content: [
					`Issue: ${input.issueNumber}`,
					`State: ${input.state ?? "unmanaged"}`,
					"Available actions:",
					actionList,
					"Bot's last message:",
					input.botContext?.trim() || "(none)",
					"Comment:",
					input.comment,
				].join("\n"),
			},
		],
		tools: [
			{
				type: "function",
				function: {
					name: "select_command",
					description: "Return the single command intended by the comment, or none.",
					parameters: {
						type: "object",
						properties: {
							event: { type: "string", description: "The selected action or none" },
							arg: { type: "string", description: "The directive for the action, if any" },
							reasoning: {
								type: "string",
								description: "A short reason quoting the decisive phrase",
							},
						},
						required: ["event", "reasoning"],
					},
				},
			},
		],
		max_tokens: 1_024,
		temperature: 0,
	};
}

function selectCommandArguments(response: Ai_Cf_Qwen_Qwen3_30B_A3B_Fp8_Output): string | null {
	if (typeof response !== "object" || response === null || !("choices" in response)) return null;
	const choice = response.choices?.[0];
	if (!choice || !("message" in choice)) return null;
	const toolCalls = choice.message?.tool_calls;
	return (
		toolCalls?.find((call) => call.function.name === "select_command")?.function.arguments ?? null
	);
}

export function resolveClassification(
	value: unknown,
	commands: ReturnType<typeof classifierCommands>,
): ClassifyResult {
	const parsed = v.safeParse(classifyResultSchema, value);
	if (!parsed.success) return { kind: "error", error: "classifier returned no structured result" };
	const result: ClassifyResponse = parsed.output;

	const reasoning = result.reasoning ?? "";
	if (!result.event || result.event === "none") {
		return { kind: "none", reasoning };
	}

	const matched = commands.find((c) => c.event === result.event);
	if (!matched) {
		return { kind: "error", error: `classifier returned unknown event "${result.event}"` };
	}

	return {
		kind: "event",
		event: matched.event,
		arg: result.arg ?? null,
		reasoning,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
