import type { SandboxFactory, SessionEnv } from "@flue/runtime";
import { describe, expect, test } from "vitest";

import { withDeadline, withSandboxDeadlines } from "../../.flue/lib/sandbox-deadline.js";

describe("withDeadline", () => {
	test("preserves a completed operation", async () => {
		await expect(withDeadline(Promise.resolve("done"), 100, "probe")).resolves.toBe("done");
	});

	test("rejects an operation that never settles", async () => {
		await expect(withDeadline(new Promise(() => {}), 10, "probe")).rejects.toThrow(
			"probe timed out after 10ms",
		);
	});
});

describe("withSandboxDeadlines", () => {
	test("applies the default deadline to file operations", async () => {
		const sandbox = await withSandboxDeadlines(
			factoryWith({ readFile: () => new Promise(() => {}) }),
			{
				defaultTimeoutMs: 10,
				execGraceMs: 5,
			},
		).createSessionEnv({ id: "test" });

		await expect(sandbox.readFile("stuck.txt")).rejects.toThrow(
			"Sandbox readFile timed out after 10ms",
		);
	});

	test("adds grace to an exec operation's native timeout", async () => {
		const sandbox = await withSandboxDeadlines(factoryWith({ exec: () => new Promise(() => {}) }), {
			defaultTimeoutMs: 100,
			execGraceMs: 5,
		}).createSessionEnv({ id: "test" });

		await expect(sandbox.exec("sleep forever", { timeoutMs: 10 })).rejects.toThrow(
			"Sandbox exec timed out after 15ms",
		);
	});
});

function factoryWith(overrides: Partial<SessionEnv>): SandboxFactory {
	const session: SessionEnv = {
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		readFile: async () => "",
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => undefined,
		stat: async () => ({ isFile: true, isDirectory: false }),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => undefined,
		rm: async () => undefined,
		cwd: "/workspace",
		resolvePath: (path) => path,
		...overrides,
	};
	return { createSessionEnv: async () => session };
}
