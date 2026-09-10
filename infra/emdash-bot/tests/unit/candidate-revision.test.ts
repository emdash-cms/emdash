import { describe, expect, test } from "vitest";

import { applyCandidateForRevision } from "../../.flue/lib/candidate-revision.js";
import type { ContainerBackend } from "../../.flue/lib/exec-env.js";

function containerWith(...results: Array<{ exitCode: number; stdout: string; stderr: string }>): {
	container: ContainerBackend;
	commands: string[];
} {
	const commands: string[] = [];
	return {
		commands,
		container: {
			isReady: async () => true,
			exec: async (command) => {
				commands.push(command);
				return results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
			},
			writeFile: async () => {},
			readFileBytes: async () => new Uint8Array(),
		},
	};
}

describe("candidate revision history", () => {
	test("deepens both histories when a depth-50 checkout has no merge base", async () => {
		const fake = containerWith(
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 1, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "base-sha\n", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
		);

		await applyCandidateForRevision(fake.container, "candidate-sha", "current-main-sha");

		expect(fake.commands).toHaveLength(5);
		expect(fake.commands[2]).toContain("git fetch --deepen 256 origin");
		expect(fake.commands[2]).toContain("'candidate-sha'");
		expect(fake.commands[2]).toContain("'current-main-sha'");
		expect(fake.commands[4]).toContain("git diff --binary 'base-sha' 'candidate-sha'");
	});
});
