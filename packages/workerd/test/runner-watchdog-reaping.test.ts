import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxModule = join(packageDir, "dist/sandbox/index.mjs");
const workerdBinary = join(packageDir, "node_modules/workerd/bin/workerd");

function commandWorks(command: string, args: string[]): boolean {
	try {
		execFileSync(command, args, { stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

const canUseNamespace =
	process.platform === "linux" &&
	existsSync("/bin/sh") &&
	existsSync(sandboxModule) &&
	commandWorks(workerdBinary, ["--version"]) &&
	commandWorks("unshare", [
		"--user",
		"--map-root-user",
		"--pid",
		"--fork",
		"--kill-child",
		"--mount-proc",
		process.execPath,
		"-e",
		"if(process.pid!==1)process.exit(1)",
	]);

const harness = (modulePath: string, crash: boolean) => `
import assert from "node:assert/strict";
import { once } from "node:events";
import { createSandboxRunner } from ${JSON.stringify(modulePath)};
import { readdir, readFile } from "node:fs/promises";

function processes() {
  return readdir("/proc").then(async (entries) => {
    const result = [];
    for (const entry of entries) {
      if (!/^\\d+$/.test(entry) || entry === "1") continue;
      try {
        const stat = await readFile("/proc/" + entry + "/stat", "utf8");
        const end = stat.lastIndexOf(")");
        const fields = stat.slice(end + 2).split(" ");
        result.push({ pid: Number(entry), ppid: Number(fields[1]), state: fields[0], comm: stat.slice(stat.indexOf("(") + 1, end) });
      } catch {
        // The process can disappear between readdir and readFile.
      }
    }
    return result;
  });
}

async function assertReaped() {
  const deadline = Date.now() + 2_000;
  let remaining = [];
  do {
    remaining = await processes();
    if (remaining.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.deepEqual(remaining, [], "namespace left processes behind: " + JSON.stringify(remaining));
}

for (let iteration = 0; iteration < 4; iteration++) {
  const runner = createSandboxRunner({ db: null });
  const plugin = await runner.load(
    { id: "watchdog-" + ${JSON.stringify(crash)} + "-" + iteration, version: "1.0.0", capabilities: [], allowedHosts: [], storage: {}, hooks: ["test"], routes: [], admin: {} },
    "export default { hooks: { test: async () => ({ healthy: true }) } };",
  );
  assert.deepEqual(await plugin.invokeHook("test", {}), { healthy: true });
  if (${JSON.stringify(crash)}) {
    const child = runner.workerdProcess;
    assert.ok(child);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  await runner.terminateAll();
  await assertReaped();
}
`;

function runInNamespace(crash: boolean): void {
	try {
		execFileSync(
			"unshare",
			[
				"--user",
				"--map-root-user",
				"--pid",
				"--fork",
				"--kill-child",
				"--mount-proc",
				process.execPath,
				"--input-type=module",
				"-e",
				harness(sandboxModule, crash),
			],
			{
				cwd: packageDir,
				env: { ...process.env, NODE_ENV: "production", EMDASH_SANDBOX_DEV: "0" },
				encoding: "utf8",
				timeout: 20_000,
				maxBuffer: 2 * 1024 * 1024,
			},
		);
	} catch (error) {
		const detail = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
		throw new Error(
			`namespace watchdog harness failed: ${detail.message}\nstdout: ${detail.stdout ?? ""}\nstderr: ${detail.stderr ?? ""}`,
			{ cause: error },
		);
	}
}

// These tests import built output. Build packages/workerd before running them.
describe.skipIf(!canUseNamespace)("workerd watchdog process reaping", () => {
	it("reaps children after normal termination", () => runInNamespace(false), 30_000);
	it("reaps children after the workerd process is killed", () => runInNamespace(true), 30_000);
});
