// Synchronous classifier dispatch from the OrchestratorDO through a fresh
// Flue 2 agent instance. The awaited handle returns the durable response's
// structured data part.

import { init } from "@flue/runtime";
import * as v from "valibot";

import { ClassifyCommand, classifyResultSchema } from "../agents/classify-command.js";
import type { EventId, StateId } from "./machine.js";
import { classifierCommands } from "./router.js";
import { DeadlineExceededError, withDeadline } from "./sandbox-deadline.js";

const CLASSIFY_TIMEOUT_MS = 10_000;

export interface ClassifyInput {
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

export async function classifyComment(input: ClassifyInput): Promise<ClassifyResult> {
	const commands = classifierCommands(input.state);
	if (commands.length === 0) return { kind: "no-commands" };

	let reply;
	try {
		const handle = init(ClassifyCommand, {
			id: `classify-${crypto.randomUUID()}`,
			uid: null,
		});
		const startedAt = performance.now();
		const receipt = await withDeadline(
			handle.dispatch({
				message: {
					kind: "signal",
					type: "github.comment",
					body: `Classify this comment: ${input.comment}`,
				},
				initialData: {
					issueNumber: input.issueNumber,
					state: input.state ?? "unmanaged",
					comment: input.comment,
					...(input.botContext ? { botContext: input.botContext } : {}),
					commands: commands.map((command) => ({
						event: command.event,
						description: command.description,
						...(command.arg ? { arg: command.arg } : {}),
					})),
				},
			}),
			CLASSIFY_TIMEOUT_MS,
			"Classifier dispatch",
		);
		const remainingMs = CLASSIFY_TIMEOUT_MS - (performance.now() - startedAt);
		if (remainingMs <= 0) {
			throw new DeadlineExceededError("Classifier read", CLASSIFY_TIMEOUT_MS);
		}
		reply = await handle.read(receipt, { signal: AbortSignal.timeout(Math.ceil(remainingMs)) });
	} catch (err) {
		return { kind: "error", error: errorMessage(err) };
	}

	const writes = reply.data.classification;
	return resolveClassification(writes?.at(-1), commands);
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
