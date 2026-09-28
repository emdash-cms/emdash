import { describe, expect, test, vi } from "vitest";

import {
	bootstrapWorkspace,
	WORKSPACE_BOOTSTRAP_TIMEOUT_MS,
} from "../../.flue/lib/workspace-bootstrap.js";

describe("workspace bootstrap", () => {
	test("runs long install and build commands in the background and polls for completion", async () => {
		const commands: string[] = [];
		const statuses = new Map<string, number>();
		const sleep = vi.fn(async () => {});
		const exec = vi.fn(async (command: string) => {
			commands.push(command);
			if (command.startsWith("test -d node_modules")) {
				return { exitCode: 1, stdout: "", stderr: "" };
			}
			if (command.includes("bgproc status")) {
				const name = command.includes("emdash-workspace-install") ? "install" : "build";
				const count = statuses.get(name) ?? 0;
				statuses.set(name, count + 1);
				return count === 0
					? { exitCode: 0, stdout: JSON.stringify({ running: true }), stderr: "" }
					: { exitCode: 0, stdout: "complete:0", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});

		await bootstrapWorkspace(
			{ exec },
			{
				repoDir: "/workspace/repo",
				onProgress: async () => {},
				sleep,
			},
		);

		expect(commands.filter((command) => command.includes("bgproc start"))).toHaveLength(2);
		expect(commands.some((command) => command.includes("bgproc status"))).toBe(true);
		expect(commands).not.toContain("pnpm install --frozen-lockfile --prefer-offline");
		expect(commands).not.toContain("pnpm build");
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	test("reports captured background logs when a workspace command fails", async () => {
		const exec = vi.fn(async (command: string) => {
			if (command.startsWith("test -d node_modules")) {
				return { exitCode: 1, stdout: "", stderr: "" };
			}
			if (command.includes("bgproc status")) {
				return { exitCode: 0, stdout: "complete:7", stderr: "" };
			}
			if (command.includes("bgproc logs")) {
				return { exitCode: 0, stdout: "native dependency download failed", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});

		await expect(
			bootstrapWorkspace(
				{ exec },
				{
					repoDir: "/workspace/repo",
					onProgress: async () => {},
					sleep: async () => {},
				},
			),
		).rejects.toThrow("dependency installation failed (7): native dependency download failed");
	});

	test("installs missing dependencies and builds once before the agent starts", async () => {
		const commands: Array<{ command: string; timeoutMs?: number }> = [];
		const progress: string[] = [];
		const exec = vi.fn(async (command: string, options?: { timeoutMs?: number }) => {
			commands.push({ command, timeoutMs: options?.timeoutMs });
			if (command.startsWith("test -d node_modules")) {
				return { exitCode: 1, stdout: "", stderr: "" };
			}
			return command.includes("bgproc status")
				? { exitCode: 0, stdout: "complete:0", stderr: "" }
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
		expect(commands[0]).toEqual({
			command: "test -d node_modules -a -f node_modules/.modules.yaml",
			timeoutMs: undefined,
		});
		expect(commands.filter(({ command }) => command.includes("bgproc start"))).toHaveLength(2);
	});

	test("reuses installed dependencies but still creates fresh base build outputs", async () => {
		const commands: string[] = [];
		const progress: string[] = [];
		const exec = vi.fn(async (command: string) => {
			commands.push(command);
			return command.includes("bgproc status")
				? { exitCode: 0, stdout: "complete:0", stderr: "" }
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

		expect(commands[0]).toBe("test -d node_modules -a -f node_modules/.modules.yaml");
		expect(commands.filter((command) => command.includes("bgproc start"))).toHaveLength(1);
		expect(commands.some((command) => command.includes("pnpm install"))).toBe(false);
		expect(progress).toEqual(["workspace_building"]);
	});

	test("fails workspace setup when the deterministic build fails", async () => {
		const exec = vi.fn(async (command: string) => {
			if (command.includes("bgproc status")) {
				return { exitCode: 0, stdout: "complete:1", stderr: "" };
			}
			if (command.includes("bgproc logs")) {
				return { exitCode: 0, stdout: "", stderr: "package build failed" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});

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
			if (command.includes("bgproc status") && command.includes("emdash-workspace-install")) {
				now += 9 * 60_000;
				return { exitCode: 0, stdout: "complete:0", stderr: "" };
			}
			if (command.includes("bgproc status")) {
				return { exitCode: 0, stdout: "complete:0", stderr: "" };
			}
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

		const starts = timeouts.filter((entry) => entry.command.includes("bgproc start"));
		expect(starts[0]?.command).toContain(`-t ${WORKSPACE_BOOTSTRAP_TIMEOUT_MS / 1_000}`);
		expect(starts[1]?.command).toContain(
			`-t ${(WORKSPACE_BOOTSTRAP_TIMEOUT_MS - 9 * 60_000) / 1_000}`,
		);
	});
});
