// Eval suite for the free-text command classifier.
//
// Run:   pnpm exec flue dev --target node     (one terminal, with gateway creds)
//        pnpm run evals                        (another)
// Sweep: FLUE_CLASSIFIER_MODEL=cf-wai/workers-ai/@cf/...  pnpm exec flue dev

import { expect } from "vitest";
import { describeEval } from "vitest-evals";

import { CASES, commandsFor } from "./cases.ts";
import { createClassifyCommandHarness, type CommandCase } from "./harness.ts";

const harness = createClassifyCommandHarness();

describeEval("command classifier (free-text intent)", { harness }, (it) => {
	for (const c of CASES) {
		it(`[${c.tag}] ${c.state}: ${c.comment.slice(0, 60)}`, async ({ run }) => {
			const input: CommandCase = {
				issueNumber: 0,
				state: c.state,
				comment: c.comment,
				botContext: c.botContext ?? "",
				commands: commandsFor(c.state),
			};
			const result = await run(input);
			expect(result.output).toBe(c.expected);
		});
	}
});
