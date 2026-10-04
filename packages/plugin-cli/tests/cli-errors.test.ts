import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
	return new Promise<{ code: number | string | undefined; output: string }>((resolve) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ cwd, env: { ...process.env, NO_COLOR: "1", ...env } },
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

it.each([
	{ command: "publish", output: "Manifest validation failed" },
	{ command: "publish --no-manifest", output: "Not logged in" },
	{ command: "publish --manifest=false", output: "Not logged in" },
	{ command: "publish --noManifest", output: "Not logged in" },
	{ command: "publish --noManifest=true", output: "Not logged in" },
	{ command: "publish --noManifest=false", output: "Manifest validation failed" },
])("$command reads the manifest unless it is skipped", async ({ command, output }) => {
	const dir = await mkdtemp(join(tmpdir(), "emdash-publish-manifest-"));
	try {
		await writeFile(join(dir, "emdash-plugin.jsonc"), "{}");
		const result = await runCli(command.split(" "), dir, { HOME: dir, USERPROFILE: dir });

		expect(result.output).toContain(output);
		expect(result.output).not.toMatch(/\n\s+at /);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
