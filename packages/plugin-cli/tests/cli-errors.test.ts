import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));

function runCli(args: string[], cwd: string) {
	return new Promise<{ code: number | string | undefined; output: string }>((resolve) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ cwd, env: { ...process.env, NO_COLOR: "1" } },
			(error, stdout, stderr) => {
				resolve({ code: error?.code, output: `${stdout}${stderr}` });
			},
		);
	});
}

it("reports a missing plugin directory without a stack trace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "emdash-release-setup-root-"));
	try {
		const result = await runCli(["release", "setup", "--yes"], dir);

		expect(result.code).toBe(1);
		expect(result.output).toContain("Run this command from a plugin directory");
		expect(result.output).toContain("--dir <plugin-directory>");
		expect(result.output).not.toContain("BuildPipelineError");
		expect(result.output).not.toMatch(/\n\s+at /);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
