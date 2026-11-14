import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxModule = join(packageDir, "dist/sandbox/index.mjs");
const workerdBinary = join(packageDir, "node_modules/workerd/bin/workerd");
const isWindows = process.platform === "win32";
let workerdAvailable = false;
try {
	execFileSync(workerdBinary, ["--version"], { stdio: "ignore", timeout: 5_000 });
	workerdAvailable = true;
} catch {
	// The integration test is optional when the peer binary is unavailable.
}

const hostSource = (
	modulePath: string,
	listener: "none" | "on" | "once" | "prependOnceListener" | "removed",
	signal: "SIGTERM" | "SIGINT",
) => `
import { createSandboxRunner } from ${JSON.stringify(modulePath)};
import { stdin, stdout } from "node:process";
${listener === "on" || listener === "once" ? `process.${listener}(${JSON.stringify(signal)}, () => stdout.write("HANDLED\\n"));` : ""}
const runner = createSandboxRunner({ db: null, siteInfo: { name: "exit-test", url: "http://localhost", locale: "en" } });
${listener === "prependOnceListener" ? `process.prependOnceListener(${JSON.stringify(signal)}, () => stdout.write("HANDLED\\n"));` : ""}
${listener === "removed" ? `const removedHandler = () => stdout.write("UNEXPECTED\\n"); process.prependOnceListener(${JSON.stringify(signal)}, removedHandler); process.off(${JSON.stringify(signal)}, removedHandler);` : ""}
const plugin = await runner.load(
  { id: "exit-test", version: "1.0.0", capabilities: [], allowedHosts: [], storage: {}, hooks: ["test"], routes: [], admin: {} },
  'export default { hooks: { test: async () => ({ ok: true }) } };',
);
await plugin.invokeHook("test", {});
const entries = [...runner.plugins.values()];
stdout.write("READY " + JSON.stringify({ pid: runner.workerdProcess.pid, port: entries[0].port, configDir: runner.configDir, socketPath: runner.backingSocketPath }) + "\\n");
stdin.setEncoding("utf8");
stdin.on("data", (command) => {
  if (command.includes("exit")) process.exit(0);
  if (command.includes("ping")) stdout.write("ALIVE\\n");
});
`;

type Ready = { pid: number; port: number; configDir: string; socketPath: string };
type Host = ReturnType<typeof spawn>;

function waitForLine(
	host: Host,
	wanted: (line: string) => boolean,
	timeout = 15_000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => {
			host.stdout?.off("data", onData);
			host.off("exit", onExit);
			reject(new Error(`Timed out waiting for host output; got ${output}`));
		}, timeout);
		const onExit = () => {
			clearTimeout(timer);
			host.stdout?.off("data", onData);
			reject(new Error(`Host exited before expected output; got ${output}`));
		};
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			for (const line of output.split("\n")) {
				if (wanted(line)) {
					clearTimeout(timer);
					host.stdout?.off("data", onData);
					host.off("exit", onExit);
					resolve(line);
					return;
				}
			}
		};
		host.stdout?.on("data", onData);
		host.once("exit", onExit);
	});
}

function waitForExit(
	host: Host,
	timeout = 8_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Host did not exit")), timeout);
		host.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
}

function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
	if (pid === undefined || isWindows) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// The process may have exited between the two checks.
		}
	}
}

function descendants(root: number): number[] {
	const parentByPid = new Map<number, number>();
	try {
		const lines = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
		for (const line of lines.trim().split("\n")) {
			const [pid, ppid] = line.trim().split(/\s+/).map(Number);
			if (pid && ppid) parentByPid.set(pid, ppid);
		}
	} catch {
		return [];
	}
	const result: number[] = [];
	const queue = [root];
	while (queue.length) {
		const parent = queue.shift()!;
		for (const [pid, ppid] of parentByPid) {
			if (ppid === parent) {
				result.push(pid);
				queue.push(pid);
			}
		}
	}
	return result;
}

function isRunning(pid: number): boolean {
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
		}
		const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
		return state.trim() !== "" && !state.trim().startsWith("Z");
	} catch {
		return false;
	}
}

async function waitForPortClosed(port: number): Promise<void> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		const open = await new Promise<boolean>((resolve) => {
			const socket = connect(port, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
		});
		if (!open) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Port ${port} remained open`);
}

async function runMode(
	mode:
		| "exit"
		| "SIGTERM"
		| "SIGINT"
		| "SIGKILL"
		| "handled"
		| "handled-once"
		| "handled-prepend"
		| "removed-prepend",
	signal: "SIGTERM" | "SIGINT" = "SIGTERM",
): Promise<void> {
	const host = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			hostSource(
				sandboxModule,
				mode === "handled"
					? "on"
					: mode === "handled-once"
						? "once"
						: mode === "handled-prepend"
							? "prependOnceListener"
							: mode === "removed-prepend"
								? "removed"
								: "none",
				signal,
			),
		],
		{
			cwd: packageDir,
			env: { ...process.env, NODE_ENV: "production", EMDASH_SANDBOX_DEV: "0" },
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	host.stderr?.resume();
	let ready: Ready | undefined;
	let knownDescendants: number[] = [];
	try {
		ready = JSON.parse(
			(await waitForLine(host, (line) => line.startsWith("READY "))).slice(6),
		) as Ready;
		expect(ready.pid).toBeGreaterThan(0);
		expect(ready.port).toBeGreaterThan(0);
		knownDescendants = descendants(host.pid!);
		if (mode.startsWith("handled")) {
			const handled = waitForLine(host, (line) => line === "HANDLED");
			host.kill(signal);
			expect(await handled).toBe("HANDLED");
			await waitForPortClosed(ready.port);
			await expect.poll(() => [ready!.configDir, ready!.socketPath].some(existsSync)).toBe(false);
			const alive = waitForLine(host, (line) => line === "ALIVE");
			host.stdin.write("ping\n");
			expect(await alive).toBe("ALIVE");
			expect(host.exitCode).toBeNull();
			return;
		}
		const exited = waitForExit(host);
		if (mode === "exit") host.stdin.write("exit\n");
		else host.kill(mode === "removed-prepend" ? signal : mode);
		const result = await exited;
		if (mode === "exit") expect(result).toEqual({ code: 0, signal: null });
		else expect(result.signal).toBe(mode === "removed-prepend" ? signal : mode);
		await waitForPortClosed(ready.port);
		if (mode !== "SIGKILL") {
			expect(existsSync(ready.configDir)).toBe(false);
			expect(existsSync(ready.socketPath)).toBe(false);
		}
		await expect
			.poll(() => [ready!.pid, ...knownDescendants].filter(isRunning), {
				timeout: 8_000,
			})
			.toEqual([]);
	} finally {
		if (host.pid) knownDescendants.push(...descendants(host.pid));
		killTree(host.pid);
		for (const pid of knownDescendants) killTree(pid);
		if (ready) killTree(ready.pid);
		if (ready) {
			rmSync(ready.configDir, { recursive: true, force: true });
			rmSync(ready.socketPath, { force: true });
		}
		if (mode.startsWith("handled") && ready) {
			await waitForPortClosed(ready.port).catch(() => {});
		}
	}
}

// These subprocess tests exercise built output; run the package build first.
describe.skipIf(isWindows || !workerdAvailable)("runner parent exit cleanup", () => {
	it("cleans up when the host calls process.exit", () => runMode("exit"), 20_000);
	it("cleans up on SIGTERM", () => runMode("SIGTERM"), 20_000);
	it("cleans up on SIGINT", () => runMode("SIGINT"), 20_000);
	it.skipIf(!existsSync("/bin/sh"))("cleans up on SIGKILL", () => runMode("SIGKILL"), 20_000);
	it("does not suppress an application SIGTERM listener", () => runMode("handled"), 20_000);
	it("preserves an application once-only SIGTERM listener", () => runMode("handled-once"), 20_000);
	it.each(["SIGTERM", "SIGINT"] as const)(
		"preserves a prepended once-only %s listener installed after construction",
		(signal) => runMode("handled-prepend", signal),
		20_000,
	);
	it.each(["SIGTERM", "SIGINT"] as const)(
		"keeps default %s exit after an application listener was removed before dispatch",
		(signal) => runMode("removed-prepend", signal),
		20_000,
	);
});
