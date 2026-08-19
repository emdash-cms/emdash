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
				now: () => 0,
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
				now: () => 0,
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
			bootstrapWorkspace(
				{ exec },
				{ repoDir: "/workspace/repo", onProgress: async () => {}, now: () => 0 },
			),
		).rejects.toThrow("workspace build failed (1): package build failed");
	});

	test("shares one timeout budget across installation and build", async () => {
		let now = 0;
		const timeouts: Array<{ command: string; timeoutMs?: number }> = [];
		const exec = vi.fn(async (command: string, options?: { timeoutMs?: number }) => {
			timeouts.push({ command, timeoutMs: options?.timeoutMs });
			if (command.startsWith("test -d node_modules")) {
				return { exitCode: 1, stdout: "", stderr: "" };
			}
			if (command.startsWith("pnpm install")) now += 9 * 60_000;
			return { exitCode: 0, stdout: "ok", stderr: "" };
		});

		await bootstrapWorkspace(
			{ exec },
			{
				repoDir: "/workspace/repo",
				onProgress: async () => {},
				now: () => now,
			},
		);

		expect(timeouts.find((entry) => entry.command.startsWith("pnpm install"))?.timeoutMs).toBe(
			WORKSPACE_BOOTSTRAP_TIMEOUT_MS,
		);
		expect(timeouts.find((entry) => entry.command === "pnpm build")?.timeoutMs).toBe(
			WORKSPACE_BOOTSTRAP_TIMEOUT_MS - 9 * 60_000,
		);
	});
});
