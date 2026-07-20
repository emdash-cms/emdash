"use agent";

import {
	defineTool,
	type AgentProps,
	useAgentFinish,
	useDataWriter,
	useInitialData,
	useModel,
	usePersistentState,
	useTool,
} from "@flue/runtime";
import * as v from "valibot";

const commandSchema = v.object({
	event: v.string(),
	description: v.string(),
	arg: v.optional(v.nullable(v.string())),
});

const initialDataSchema = v.object({
	issueNumber: v.number(),
	state: v.string(),
	comment: v.pipe(v.string(), v.minLength(1)),
	botContext: v.optional(v.string()),
	commands: v.pipe(v.array(commandSchema), v.minLength(1)),
});

export const classifyResultSchema = v.object({
	event: v.string(),
	arg: v.optional(v.nullable(v.string())),
	reasoning: v.pipe(v.string(), v.minLength(3), v.maxLength(400)),
});

export type ClassifyAgentResult = v.InferOutput<typeof classifyResultSchema>;
type ClassifyAgentData = v.InferOutput<typeof initialDataSchema>;

export function ClassifyCommand(_props: AgentProps) {
	const input = useInitialData<ClassifyAgentData>();
	const [result, setResult] = usePersistentState<ClassifyAgentResult | null>("result", null);
	const [reminded, setReminded] = usePersistentState("reminded", false);
	const writeResult = useDataWriter("classification", { schema: classifyResultSchema });
	const choices = new Set([...input.commands.map((command) => command.event), "none"]);

	useModel("cloudflare/@cf/qwen/qwen3-30b-a3b-fp8");
	useTool(
		defineTool({
			name: "select_command",
			description: "Return the single command intended by the comment, or none.",
			input: v.object({
				event: v.pipe(
					v.string(),
					v.check((event) => choices.has(event), "Choose an available event or none"),
				),
				arg: v.optional(v.nullable(v.string())),
				reasoning: v.pipe(v.string(), v.minLength(3), v.maxLength(400)),
			}),
			output: classifyResultSchema,
			async run({ data }) {
				const classification = {
					event: data.event,
					arg: data.arg ?? null,
					reasoning: data.reasoning,
				};
				setResult(classification);
				writeResult(classification);
				return classification;
			},
		}),
	);

	useAgentFinish(({ response, append }) => {
		const selected = response.toolCalls.some(
			(call) => call.tool === "select_command" && !call.isError,
		);
		if (result || selected) return;
		if (!reminded) {
			setReminded(true);
			append({
				kind: "signal",
				type: "classification.required",
				body: "Call select_command now. Do not answer with prose.",
			});
			return;
		}

		const fallback = { event: "none", arg: null, reasoning: "No clear command selected" };
		setResult(fallback);
		writeResult(fallback);
	});

	const actionList = input.commands
		.map(
			(command) =>
				`- \`${command.event}\`: ${command.description}${command.arg ? ` (set \`arg\` to the ${command.arg})` : ""}`,
		)
		.join("\n");

	return [
		"Route the comment addressed to the EmDash issue bot to exactly one action.",
		`The item is in state \`${input.state}\`.`,
		"",
		"## Available actions",
		"",
		actionList,
		"- `none`: no actionable intent matches the available actions.",
		"",
		"## The bot's last message",
		"",
		input.botContext?.trim() || "(none)",
		"",
		"## The comment",
		"",
		input.comment,
		"",
		"Call select_command exactly once. Prefer none over guessing. Quote the decisive phrase in reasoning.",
	].join("\n");
}

ClassifyCommand.agentName = "classify-command";
ClassifyCommand.initialData = initialDataSchema;
ClassifyCommand.durability = { maxAttempts: 3, timeoutMs: 30_000 };
