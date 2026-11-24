/**
 * stopWorkerd Timer Cleanup Tests
 *
 * Regression coverage for a hygiene bug in WorkerdSandboxRunner.stopWorkerd():
 * the SIGTERM-then-SIGKILL fallback timer was never cleared when the process
 * exited cleanly. The `if (!exited)` guard prevented an actual signal from
 * being sent, but the timer itself still held the Node event loop alive for
 * up to 5 seconds past clean termination -- delaying terminateAll() and
 * process shutdown.
 *
 * The fix extracted the exit/timer dance into `waitForProcessExit()` and
 * clears the timer inside the exit listener.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as net from "node:net";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
	makeWorkerdExitHandler,
	WorkerdSandboxRunner,
	waitForProcessExit,
} from "../src/sandbox/runner.js";
import type { ExitHandlerHost } from "../src/sandbox/runner.js";
import { spawnWorkerd } from "../src/sandbox/workerd-process.js";

interface FakeProc extends EventEmitter {
	exitCode: number | null;
	kill: ReturnType<typeof vi.fn>;
}

function makeFakeProc(): FakeProc {
	const proc = new EventEmitter() as FakeProc;
	proc.exitCode = null;
	proc.kill = vi.fn();
	return proc;
}

describe("waitForProcessExit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears the SIGKILL timer when the process exits cleanly", async () => {
		const fake = makeFakeProc();

		const stopPromise = waitForProcessExit(fake as unknown as ChildProcess);

		// SIGTERM was queued synchronously.
		expect(fake.kill).toHaveBeenCalledWith("SIGTERM");

		// Process exits well before the 5s timeout.
		await vi.advanceTimersByTimeAsync(100);
		fake.emit("exit");
		await stopPromise;

		// The kill timer must have been cleared -- nothing pending in the
		// fake timer queue. This is the load-bearing assertion: without
		// clearTimeout(), getTimerCount() would be 1 here and the timer
		// would keep the real event loop alive for ~5s past termination.
		expect(vi.getTimerCount()).toBe(0);

		// Jump past the original 5s mark. SIGKILL must NOT be sent.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.kill).toHaveBeenCalledTimes(1);
		expect(fake.kill).not.toHaveBeenCalledWith("SIGKILL");
	});

	it("sends SIGKILL when the process does not exit within the timeout", async () => {
		const fake = makeFakeProc();

		const stopPromise = waitForProcessExit(fake as unknown as ChildProcess);
		expect(fake.kill).toHaveBeenCalledWith("SIGTERM");

		// 5s elapses with no exit -- timer fires SIGKILL.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.kill).toHaveBeenCalledWith("SIGKILL");

		// Now exit; stopPromise resolves.
		fake.emit("exit");
		await stopPromise;
	});

	it("respects a custom timeout", async () => {
		const fake = makeFakeProc();
		const stopPromise = waitForProcessExit(fake as unknown as ChildProcess, 1_000);

		// At 999ms no SIGKILL.
		await vi.advanceTimersByTimeAsync(999);
		expect(fake.kill).not.toHaveBeenCalledWith("SIGKILL");

		// At 1000ms SIGKILL fires.
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.kill).toHaveBeenCalledWith("SIGKILL");

		fake.emit("exit");
		await stopPromise;
	});
});

describe("stopWorkerd timer cleanup", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears the SIGKILL timer when the process exits cleanly", async () => {
		const runner = new WorkerdSandboxRunner({ db: null as any });
		const fake = makeFakeProc();
		(runner as any).workerdProcess = fake;

		const stopPromise = (runner as any).stopWorkerd() as Promise<void>;
		expect(fake.kill).toHaveBeenCalledWith("SIGTERM");

		await vi.advanceTimersByTimeAsync(100);
		fake.emit("exit");
		await stopPromise;

		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.kill).not.toHaveBeenCalledWith("SIGKILL");
	});

	it("fast-paths when exitCode is already set", async () => {
		const runner = new WorkerdSandboxRunner({ db: null as any });
		const fake = makeFakeProc();
		fake.exitCode = 0;
		(runner as any).workerdProcess = fake;

		await (runner as any).stopWorkerd();

		expect(fake.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("treats a replacement process crash as unexpected after an intentional stop", async () => {
		const runner = new WorkerdSandboxRunner({ db: null as any });
		const stopped = makeFakeProc();
		(runner as any).workerdProcess = stopped;
		const stopPromise = (runner as any).stopWorkerd() as Promise<void>;
		stopped.emit("exit");
		await stopPromise;

		const replacement = makeFakeProc();
		(runner as any).workerdProcess = replacement;
		(runner as any).healthy = true;
		const scheduleRestart = vi.spyOn(runner as any, "scheduleRestart").mockImplementation(() => {});
		makeWorkerdExitHandler(runner as unknown as ExitHandlerHost, replacement as ChildProcess)(
			1,
			null,
		);

		expect(scheduleRestart).toHaveBeenCalledOnce();
	});
});

describe.skipIf(process.platform === "win32")(
	"waitForProcessExit process-group termination",
	() => {
		it("terminates a listener descendant when force stopping its launcher", async () => {
			const descendantScript = `
const http = require("node:http");
process.on("SIGTERM", () => {});
const server = http.createServer((_request, response) => response.end("ok"));
server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (address && typeof address !== "string") {
		process.stdout.write(JSON.stringify({ pid: process.pid, port: address.port }) + "\\n");
	}
});
`;
			const launcherScript = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
	stdio: ["ignore", "pipe", "inherit"],
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
`;
			const launcher = spawnWorkerd(process.execPath, ["-e", launcherScript], {});
			let output = "";
			let stderr = "";
			let descendantStopped = false;
			let descendantPid: number | undefined;
			let port: number | undefined;

			launcher.stdout?.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				const match = output.match(/\{"pid":(\d+),"port":(\d+)\}/);
				if (match) {
					descendantPid = Number(match[1]);
					port = Number(match[2]);
				}
			});
			launcher.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			const canConnect = (targetPort: number) =>
				new Promise<boolean>((resolve) => {
					const socket = net.createConnection({ host: "127.0.0.1", port: targetPort });
					const finish = (connected: boolean) => {
						socket.destroy();
						resolve(connected);
					};
					socket.once("connect", () => finish(true));
					socket.once("error", () => finish(false));
					socket.setTimeout(250, () => finish(false));
				});

			const waitForConnection = async (expected: boolean, timeoutMs: number) => {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					if (port !== undefined && (await canConnect(port)) === expected) return;
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				throw new Error(`listener did not become ${expected ? "ready" : "closed"}: ${stderr}`);
			};

			try {
				await waitForConnection(true, 3_000);
				expect(descendantPid).toBeDefined();
				await waitForProcessExit(launcher, 5_000, { force: true });
				await waitForConnection(false, 2_000);
				descendantStopped = true;
			} finally {
				if (
					launcher.pid !== undefined &&
					launcher.exitCode === null &&
					launcher.signalCode === null
				) {
					try {
						process.kill(-launcher.pid, "SIGKILL");
					} catch {}
				}
				if (descendantPid !== undefined && !descendantStopped) {
					try {
						process.kill(descendantPid, "SIGKILL");
					} catch {}
				}
			}
		}, 10_000);
	},
);
