// Synchronous classifier dispatch from the OrchestratorDO.
//
// The classifier itself runs as a Flue workflow at /workflows/classify-command.
// To get a result back in-process we hit that route via the SELF service binding
// with ?wait=result. The DO blocks for the classifier turn (~1-2s) and then
// re-enters event() with the resolved verb.

import { classifierCommands } from "./router.js";
import type { EventId, StateId } from "./machine.js";

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

export async function classifyComment(self: Fetcher, input: ClassifyInput): Promise<ClassifyResult> {
	const commands = classifierCommands(input.state);
	if (commands.length === 0) return { kind: "no-commands" };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);

	let res: Response;
	try {
		res = await self.fetch("https://self/workflows/classify-command?wait=result", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				issueNumber: input.issueNumber,
				state: input.state ?? "unmanaged",
				comment: input.comment,
				...(input.botContext ? { botContext: input.botContext } : {}),
				commands: commands.map((c) => ({
					event: c.event,
					description: c.description,
					...(c.arg ? { arg: c.arg } : {}),
				})),
			}),
			signal: controller.signal,
		});
	} catch (err) {
		return { kind: "error", error: (err as Error).message };
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) {
		return { kind: "error", error: `classify HTTP ${res.status}: ${await res.text()}` };
	}

	const json = (await res.json()) as { result?: ClassifyResponse } | ClassifyResponse;
	// `?wait=result` may wrap the result in { result: ... } or return it
	// directly depending on Flue version; handle both.
	const result: ClassifyResponse =
		"result" in json && json.result ? json.result : (json as ClassifyResponse);

	const reasoning = result.reasoning ?? "";
	if (!result.event || result.event === "none") {
		return { kind: "none", reasoning };
	}

	if (!isKnownEvent(result.event, commands)) {
		return { kind: "error", error: `classifier returned unknown event "${result.event}"` };
	}

	return {
		kind: "event",
		event: result.event as EventId,
		arg: result.arg ?? null,
		reasoning,
	};
}

function isKnownEvent(event: string, commands: ReturnType<typeof classifierCommands>): boolean {
	for (const c of commands) if (c.event === event) return true;
	return false;
}
