import { describe, expect, test, vi } from "vitest";

import {
	bootstrapWorkspace,
	WORKSPACE_BOOTSTRAP_TIMEOUT_MS,
} from "../../.flue/lib/workspace-bootstrap.js";

describe("workspace bootstrap", () => {
	test("installs missing dependencies and builds once before the agent starts", async () => {
		const commands: Array<{ command: string; timeoutMs?: number }> = [];
		const progress: string[] = [];
		const exec = vi.fn(async (command: string, options?: { timeoutMs?: number }) => {
			commands.push({ command, timeoutMs: options?.timeoutMs });
			return command.startsWith("test -d node_modules")
				? { exitCode: 1, stdout: "", stderr: "" }
				: { exitCode: 0, stdout: "ok", stderr: "" };
		});

		await bootstrapWorkspace(
			{ exec },
			{
				repoDir: "/workspace/repo",
				onProgress: async (stage) => {
					progress.push(stage);
				},
			},
		);

		expect(progress).toEqual(["workspace_installing", "workspace_building"]);
		expect(commands).toEqual([
			{ command: "test -d node_modules -a -f node_modules/.modules.yaml", timeoutMs: undefined },
			{
				command: "pnpm install --frozen-lockfile --prefer-offline",
				timeoutMs: WORKSPACE_BOOTSTRAP_TIMEOUT_MS,
			},
			{ command: "pnpm build", timeoutMs: WORKSPACE_BOOTSTRAP_TIMEOUT_MS },
		]);
	});

	test("reuses installed dependencies but still creates fresh base build outputs", async () => {
		const commands: string[] = [];
		const progress: string[] = [];
		const exec = vi.fn(async (command: string) => {
			commands.push(command);
			return { exitCode: 0, stdout: "ok", stderr: "" };
		});

		await bootstrapWorkspace(
			{ exec },
			{
				repoDir: "/workspace/repo",
				onProgress: async (stage) => {
					progress.push(stage);
				},
			},
		);

		expect(commands).toEqual([
			"test -d node_modules -a -f node_modules/.modules.yaml",
			"pnpm build",
		]);
		expect(progress).toEqual(["workspace_building"]);
	});

	test("fails workspace setup when the deterministic build fails", async () => {
		const exec = vi.fn(async (command: string) =>
			command === "pnpm build"
				? { exitCode: 1, stdout: "", stderr: "package build failed" }
				: { exitCode: 0, stdout: "", stderr: "" },
		);

		await expect(
			bootstrapWorkspace({ exec }, { repoDir: "/workspace/repo", onProgress: async () => {} }),
		).rejects.toThrow("workspace build failed (1): package build failed");
	});
});
