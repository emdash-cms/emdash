// flue-blueprint: tooling/vitest-evals@1 (workflow variant)
//
// Harness for evaluating the `classify-command` WORKFLOW (not an agent). Each
// case invokes the workflow through @flue/sdk against a running `flue dev`
// server and returns the classified machine event as the eval output, so a
// labeled (state, comment) -> event dataset can assert exact contracts and a
// model sweep can compare classifier models on the same suite.

import { createFlueClient } from "@flue/sdk";
import { createHarness } from "vitest-evals";

export interface CommandCase {
	issueNumber: number;
	state: string;
	comment: string;
	botContext?: string;
	commands: Array<{ event: string; description: string; arg?: string | null }>;
}

export function createClassifyCommandHarness(options?: { baseUrl?: string; token?: string }) {
	const client = createFlueClient({
		baseUrl: options?.baseUrl ?? process.env.FLUE_BASE_URL ?? "http://127.0.0.1:3583",
		token: options?.token,
	});

	return createHarness<CommandCase, string>({
		name: "classify-command-workflow",
		run: async ({ input }) => {
			const invocation = await client.workflows.invoke("classify-command", {
				input,
				wait: "result",
			});
			const result = (invocation.result ?? {}) as { event?: string; arg?: string; reasoning?: string };
			const output = result.event ?? "none";
			return {
				// The classified machine event is the contract under test.
				output,
				messages: [
					{ role: "user" as const, content: input.comment },
					{ role: "assistant" as const, content: output },
				],
				metadata: {
					runId: invocation.runId,
					arg: result.arg,
					reasoning: result.reasoning,
				},
			};
		},
	});
}
