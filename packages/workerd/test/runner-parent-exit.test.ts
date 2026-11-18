import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
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
	listener: "none" | "on" | "once" | "prependOnceListener" | "removed" | "reraised",
	signal: "SIGTERM" | "SIGINT",
	shellless: boolean,
	binaryPath?: string,
) => `
import { createSandboxRunner } from ${JSON.stringify(modulePath)};
import { stdin, stdout } from "node:process";
import { connect } from "node:net";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
${shellless ? `const existsSync = fs.existsSync; fs.existsSync = (path) => path === "/bin/sh" ? false : existsSync(path); syncBuiltinESMExports();` : ""}
${listener === "on" || listener === "once" ? `process.${listener}(${JSON.stringify(signal)}, () => stdout.write("HANDLED\\n"));` : ""}
${listener === "reraised" ? `function reraise() { if (process.listenerCount(${JSON.stringify(signal)}) === 1) { process.off(${JSON.stringify(signal)}, reraise); process.kill(process.pid, ${JSON.stringify(signal)}); } } process.on(${JSON.stringify(signal)}, reraise);` : ""}
const runner = createSandboxRunner({ db: null, siteInfo: { name: "exit-test", url: "http://localhost", locale: "en" } });
${binaryPath ? `runner.resolveWorkerdBinary = () => ${JSON.stringify(binaryPath)};` : ""}
${listener === "prependOnceListener" ? `process.prependOnceListener(${JSON.stringify(signal)}, () => stdout.write("HANDLED\\n"));` : ""}
${listener === "removed" ? `const removedHandler = () => stdout.write("UNEXPECTED\\n"); process.prependOnceListener(${JSON.stringify(signal)}, removedHandler); process.off(${JSON.stringify(signal)}, removedHandler);` : ""}
const plugin = await runner.load(
  { id: "exit-test", version: "1.0.0", capabilities: [], allowedHosts: [], storage: {}, hooks: ["test"], routes: ["ping"], admin: {} },
  'export default { hooks: { test: async () => ({ ok: true }) }, routes: { ping: { handler: async () => ({ ok: true }) } } };',
);
await plugin.invokeHook("test", {});
const backingConnections = [];
async function holdBackingConnection() {
  const connection = connect(runner.backingSocketPath);
  await once(connection, "connect");
  connection.unref();
  backingConnections.push(connection);
}
await holdBackingConnection();
const entries = [...runner.plugins.values()];
stdout.write("READY " + JSON.stringify({ pid: runner.workerdProcess.pid, port: entries[0].port, configDir: runner.configDir, socketPath: runner.backingSocketPath }) + "\\n");
stdin.setEncoding("utf8");
stdin.on("data", async (command) => {
  if (command.includes("exit")) process.exit(0);
  if (command.includes("drain")) {
    try {
      const hook = await plugin.invokeHook("test", {});
      await holdBackingConnection();
      const route = await plugin.invokeRoute("ping", {}, { url: "http://localhost/ping", method: "GET", headers: {} });
      stdout.write("DRAIN_OK " + JSON.stringify({ hook, route }) + "\\n");
    } catch (error) {
      stdout.write("DRAIN_FAILED " + error.message + "\\n");
    }
  }
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
		| "removed-prepend"
		| "reraised",
	signal: "SIGTERM" | "SIGINT" = "SIGTERM",
	shellless = false,
	useFakeBinary = false,
): Promise<void> {
	const fakeBinaryDir = useFakeBinary
		? mkdtempSync(join(tmpdir(), "emdash-fake-workerd-"))
		: undefined;
	const fakeBinary = fakeBinaryDir ? join(fakeBinaryDir, "workerd") : undefined;
	if (fakeBinary) {
		writeFileSync(
			fakeBinary,
			`#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
if (process.argv[2] === "--version") process.exit(0);
const config = fs.readFileSync(process.argv[3], "utf8");
const socket = /name = "(socket-[^"]+)"/.exec(config)[1];
process.on("SIGTERM", () => {});
const server = http.createServer((req, res) => {
  if (req.url === "/__ready") return res.writeHead(200).end("ok");
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value: { ok: true } }));
});
server.listen(0, "127.0.0.1", () => {
  fs.writeSync(3, JSON.stringify({ event: "listen", socket, port: server.address().port }) + "\\n");
});
`,
		);
		chmodSync(fakeBinary, 0o755);
	}
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
								: mode === "reraised"
									? "reraised"
									: "none",
				signal,
				shellless,
				fakeBinary,
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
			const drained = waitForLine(host, (line) => line.startsWith("DRAIN_"));
			host.stdin.write("drain\n");
			if (shellless) expect(await drained).toContain("DRAIN_FAILED Plugin sandbox unavailable");
			else expect(await drained).toBe('DRAIN_OK {"hook":{"ok":true},"route":{"ok":true}}');
			expect(host.exitCode).toBeNull();
		}
		const exited = waitForExit(host);
		if (mode.startsWith("handled")) host.stdin.end();
		else if (mode === "exit") host.stdin.write("exit\n");
		else host.kill(mode === "removed-prepend" || mode === "reraised" ? signal : mode);
		const result = await exited;
		if (mode === "exit" || mode.startsWith("handled"))
			expect(result).toEqual({ code: 0, signal: null });
		else
			expect(result.signal).toBe(mode === "removed-prepend" || mode === "reraised" ? signal : mode);
		await waitForPortClosed(ready.port);
		if (mode !== "SIGKILL" && (mode !== "reraised" || shellless)) {
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
		if (fakeBinaryDir) rmSync(fakeBinaryDir, { recursive: true, force: true });
	}
}

// These subprocess tests exercise built output; run the package build first.
describe.skipIf(isWindows || !workerdAvailable)("runner parent exit cleanup", () => {
	it("cleans up when the host calls process.exit", () => runMode("exit"), 20_000);
	it("cleans up on SIGTERM", () => runMode("SIGTERM"), 20_000);
	it("cleans up on SIGINT", () => runMode("SIGINT"), 20_000);
	it.skipIf(!existsSync("/bin/sh"))("cleans up on SIGKILL", () => runMode("SIGKILL"), 20_000);
	it.skipIf(!existsSync("/bin/sh")).each(["SIGTERM", "SIGINT"] as const)(
		"keeps hooks and routes available during an application-owned %s drain",
		(signal) => runMode("handled", signal),
		20_000,
	);
	it.skipIf(!existsSync("/bin/sh")).each(["SIGTERM", "SIGINT"] as const)(
		"keeps hooks and routes available during a once-only %s drain",
		(signal) => runMode("handled-once", signal),
		20_000,
	);
	it.skipIf(!existsSync("/bin/sh")).each(["SIGTERM", "SIGINT"] as const)(
		"preserves a prepended once-only %s listener installed after construction",
		(signal) => runMode("handled-prepend", signal),
		20_000,
	);
	it.each(["SIGTERM", "SIGINT"] as const)(
		"keeps default %s exit after an application listener was removed before dispatch",
		(signal) => runMode("removed-prepend", signal),
		20_000,
	);
	it.skipIf(!existsSync("/bin/sh")).each(["SIGTERM", "SIGINT"] as const)(
		"does not block an application %s handler that re-raises only when alone",
		(signal) => runMode("reraised", signal),
		20_000,
	);
	it.each(["SIGTERM", "SIGINT"] as const)(
		"cleans up on shell-less POSIX when an application re-raises %s",
		(signal) => runMode("reraised", signal, true),
		20_000,
	);
	it.each(["SIGTERM", "SIGINT"] as const)(
		"stops sandboxes before a shell-less application-owned %s drain",
		(signal) => runMode("handled", signal, true),
		20_000,
	);
	it.each(["SIGTERM", "SIGINT"] as const)(
		"cleans up an unhandled shell-less %s with a SIGTERM-resistant sidecar",
		(signal) => runMode(signal, signal, true, true),
		20_000,
	);
});
