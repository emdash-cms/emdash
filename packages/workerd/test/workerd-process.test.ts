import { ChildProcess, spawn } from "node:child_process";
import type { ChildProcess as ChildProcessType } from "node:child_process";
import { existsSync as realExistsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat as fsStat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";

import { describe, expect, it, vi } from "vitest";

const { childProcess, shellOverride } = vi.hoisted(() => ({
	childProcess: { spawn: undefined as typeof import("node:child_process").spawn | undefined },
	shellOverride: { value: undefined as boolean | undefined },
}));

vi.mock("node:child_process", async (importOriginal) => {
	const nodeChildProcess = await importOriginal<typeof import("node:child_process")>();
	childProcess.spawn = nodeChildProcess.spawn;
	return { ...nodeChildProcess, spawn: vi.fn(nodeChildProcess.spawn) };
});

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		existsSync: (path: Parameters<typeof fs.existsSync>[0]) =>
			shellOverride.value === undefined ? fs.existsSync(path) : shellOverride.value,
	};
});

import { signalWorkerd, spawnWorkerd } from "../src/sandbox/workerd-process.js";
import { waitForWorkerdReady } from "../src/sandbox/workerd-startup.js";

const posix = process.platform !== "win32";

async function closeWithin(
	child: ChildProcessType,
	timeoutMs = 1_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode };
	}
	let onClose!: (code: number | null, signal: NodeJS.Signals | null) => void;
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		onClose = (code, signal) => resolve({ code, signal });
		child.once("close", onClose);
	});
	try {
		return await withTimeout(closed, timeoutMs);
	} catch {
		return undefined;
	} finally {
		child.off("close", onClose);
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function terminate(child: ChildProcessType): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) signalWorkerd(child, "SIGKILL");
	await closeWithin(child);
}

async function waitForOutput(
	child: ChildProcessType,
	pattern: RegExp,
	timeoutMs = 1_500,
): Promise<RegExpMatchArray> {
	let output = "";
	child.stdout?.setEncoding("utf8");
	return withTimeout(
		new Promise<RegExpMatchArray>((resolve, reject) => {
			const onData = (chunk: string) => {
				output += chunk;
				const match = output.match(pattern);
				if (match) {
					child.stdout?.off("data", onData);
					resolve(match);
				}
			};
			child.stdout?.on("data", onData);
			if (!child.stdout) reject(new Error("stdout is unavailable"));
		}),
		timeoutMs,
	);
}

async function expectVictimResponse(port: number): Promise<void> {
	const response = await withTimeout(fetch(`http://127.0.0.1:${port}`), 1_000);
	expect(await response.text()).toBe("victim");
}

describe("workerd process lifecycle", () => {
	it.skipIf(!posix)("supports shell-less POSIX spawning and group termination", async () => {
		shellOverride.value = false;
		const child = spawnWorkerd(
			execPath,
			["-e", 'console.log("READY");setInterval(()=>{},1000)'],
			{},
		);
		try {
			await withTimeout(
				new Promise<void>((resolve, reject) => {
					const stdout = child.stdout;
					if (!stdout) return reject(new Error("stdout is unavailable"));
					const timer = setTimeout(() => {
						stdout.removeListener("data", onData);
						reject(new Error("readiness timed out"));
					}, 1_000);
					function onData(chunk: Buffer): void {
						if (!chunk.toString().includes("READY")) return;
						clearTimeout(timer);
						stdout.removeListener("data", onData);
						resolve();
					}
					stdout.on("data", onData);
				}),
				1_500,
			);
			signalWorkerd(child, "SIGTERM");
			const result = await closeWithin(child);
			expect(result?.signal).toBe("SIGTERM");
		} finally {
			await terminate(child);
			shellOverride.value = undefined;
		}
	});

	it.skipIf(!posix || !realExistsSync("/bin/sh"))(
		"reports a missing shell command instead of waiting for startup timeout",
		async () => {
			const missing = "/definitely/not/a/workerd-binary";
			const child = spawnWorkerd(missing, [], {});
			try {
				const ready = waitForWorkerdReady(child, new Map(), async () => false, 10_000);
				await expect(withTimeout(ready, 1_000)).rejects.toThrow(
					new RegExp(`code 12[67].*${missing.replaceAll("/", "\\/")}`),
				);
			} finally {
				await terminate(child);
			}
		},
	);

	it.skipIf(!posix || !realExistsSync("/bin/sh"))(
		"does not release the start gate when the watchdog fails to spawn",
		async () => {
			const nativeSpawn = childProcess.spawn;
			if (!nativeSpawn) throw new Error("native spawn is unavailable");
			const spawnMock = vi.mocked(spawn);
			spawnMock.mockImplementationOnce(nativeSpawn);
			spawnMock.mockImplementationOnce(() => nativeSpawn("/nonexistent/watchdog"));

			const child = spawnWorkerd(
				process.execPath,
				["-e", 'console.log("UNSUPERVISED"); setInterval(()=>{},1000)'],
				{},
			);
			let stdout = "";
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			try {
				const ready = waitForWorkerdReady(child, new Map(), async () => false, 10_000);
				await expect(withTimeout(ready, 1_000)).rejects.toThrow(
					"workerd exited during startup with signal SIGKILL",
				);
				await closeWithin(child);
				expect(stdout).not.toContain("UNSUPERVISED");
			} finally {
				await terminate(child);
				spawnMock.mockReset();
				spawnMock.mockImplementation(nativeSpawn);
			}
		},
	);

	it.skipIf(!posix || !realExistsSync("/bin/sh"))(
		"does not kill a recycled process-group id when the native process exits",
		async () => {
			const nativeSpawn = childProcess.spawn;
			if (!nativeSpawn) throw new Error("native spawn is unavailable");
			const victim = nativeSpawn(
				execPath,
				[
					"-e",
					'const server=require("node:http").createServer((_,res)=>res.end("victim")); server.listen(0,"127.0.0.1",()=>console.log(`PORT:${server.address().port}`)); setInterval(()=>{},1000);',
				],
				{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
			);
			let watchdog: ChildProcessType | undefined;
			let native: ChildProcessType | undefined;
			const spawnMock = vi.mocked(spawn);
			const victimPid = victim.pid;
			let victimPort: number | undefined;
			try {
				if (victimPid === undefined) throw new Error("victim has no pid");
				victimPort = Number((await waitForOutput(victim, /PORT:(\d+)/))[1]);
				spawnMock.mockImplementationOnce(nativeSpawn);
				spawnMock.mockImplementationOnce((...args) => {
					const [file, argv, options] = args;
					const rewritten = [...(argv ?? [])];
					rewritten[rewritten.length - 1] = String(victimPid);
					watchdog = nativeSpawn(file, rewritten, options);
					return watchdog;
				});
				native = spawnWorkerd(
					execPath,
					["-e", 'console.log("READY");setInterval(()=>{},1000)'],
					{},
				);
				await waitForOutput(native, /READY/);
				if (!watchdog) throw new Error("watchdog was not spawned");
				if (process.platform === "linux" && watchdog.pid !== undefined) {
					const stat = await readFile(`/proc/${watchdog.pid}/stat`, "utf8");
					expect(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]).toBe(String(process.pid));
				}
				signalWorkerd(native, "SIGTERM");
				expect((await closeWithin(native, 1_500))?.signal).toBe("SIGTERM");
				expect((await closeWithin(watchdog, 1_500))?.code).toBe(0);
				if (process.platform === "linux" && watchdog.pid !== undefined)
					expect(realExistsSync(`/proc/${watchdog.pid}`)).toBe(false);
				if (victimPort === undefined) throw new Error("victim did not report a port");
				await expectVictimResponse(victimPort);
			} finally {
				spawnMock.mockReset();
				spawnMock.mockImplementation(nativeSpawn);
				if (watchdog && watchdog.exitCode === null && watchdog.signalCode === null)
					await terminate(watchdog);
				if (native) await terminate(native);
				if (victimPid !== undefined && victim.exitCode === null && victim.signalCode === null) {
					try {
						process.kill(-victimPid, "SIGKILL");
					} catch {
						// The victim may have exited after the response.
					}
					await closeWithin(victim);
				}
			}
		},
	);

	it.skipIf(!posix || !realExistsSync("/bin/sh"))(
		"rethrows a synchronous watchdog spawn error and reaps the native gate",
		async () => {
			const nativeSpawn = childProcess.spawn;
			if (!nativeSpawn) throw new Error("native spawn is unavailable");
			const spawnMock = vi.mocked(spawn);
			let native: ChildProcessType | undefined;
			let stdout = "";
			const testError = Object.assign(new Error("out of memory"), { code: "ENOMEM" });
			spawnMock.mockImplementationOnce((...args) => (native = nativeSpawn(...args)));
			spawnMock.mockImplementationOnce(() => {
				throw testError;
			});
			try {
				expect(() => spawnWorkerd(execPath, ["-e", 'console.log("UNSUPERVISED")'], {})).toThrow(
					testError,
				);
				if (!native) throw new Error("native gate was not spawned");
				native.stdout?.setEncoding("utf8");
				native.stdout?.on("data", (chunk: string) => {
					stdout += chunk;
				});
				expect((await closeWithin(native, 1_500))?.signal).toBe("SIGKILL");
				expect(stdout).not.toContain("UNSUPERVISED");
			} finally {
				spawnMock.mockReset();
				spawnMock.mockImplementation(nativeSpawn);
				if (native && native.exitCode === null && native.signalCode === null)
					await terminate(native);
			}
		},
	);

	it.skipIf(!posix || !realExistsSync("/bin/sh"))(
		"cleans up when the watchdog emits error without close",
		async () => {
			const nativeSpawn = childProcess.spawn;
			if (!nativeSpawn) throw new Error("native spawn is unavailable");
			const spawnMock = vi.mocked(spawn);
			const baseline = process.listeners("exit").length;
			let native: ChildProcessType | undefined;
			const fakeWatchdog = new ChildProcess();
			spawnMock.mockImplementationOnce((...args) => (native = nativeSpawn(...args)));
			spawnMock.mockImplementationOnce(() => {
				queueMicrotask(() => fakeWatchdog.emit("error", new Error("watchdog failed")));
				return fakeWatchdog;
			});
			try {
				const child = spawnWorkerd(execPath, ["-e", 'console.log("UNSUPERVISED")'], {});
				if (!native) throw new Error("native gate was not spawned");
				expect((await closeWithin(child, 1_500))?.signal).toBe("SIGKILL");
				await expect
					.poll(() => process.listeners("exit").length, { timeout: 1_000 })
					.toBe(baseline);
			} finally {
				spawnMock.mockReset();
				spawnMock.mockImplementation(nativeSpawn);
				if (native && native.exitCode === null && native.signalCode === null)
					await terminate(native);
			}
		},
	);

	it.skipIf(!posix)("does not throw when process-group cleanup is denied", async () => {
		const child = spawnWorkerd(execPath, ["-e", "setInterval(()=>{},1000)"], {});
		const kill = vi.spyOn(process, "kill");
		kill.mockImplementationOnce(() => {
			throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		});
		try {
			expect(() => signalWorkerd(child, "SIGTERM")).not.toThrow();
		} finally {
			kill.mockRestore();
			await terminate(child);
		}
	});
	it.skipIf(!posix)("treats executable paths and arguments as literal data", async () => {
		const directory = await mkdtemp(join(tmpdir(), "emdash-literal-argv-"));
		const marker = join(directory, "injected");
		const binary = join(directory, "node with spaces ' ; $literal");
		const args = ["space separated", "quote'\"\\backslash", "line\nbreak", `;$(touch ${marker})`];
		let child: ChildProcessType | undefined;
		try {
			await symlink(execPath, binary);
			child = spawnWorkerd(
				binary,
				["-e", 'console.log("RESULT:" + JSON.stringify(process.argv.slice(1)))', "--", ...args],
				{},
			);
			const output = await waitForOutput(child, /RESULT:(.*)/);
			expect(JSON.parse(output[1]!)).toEqual(args);
			expect((await closeWithin(child))?.code).toBe(0);
			expect(realExistsSync(marker)).toBe(false);
		} finally {
			if (child) await terminate(child);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix || !realExistsSync("/bin/sh"))(
		"uses private permissions for the supervisor script and removes it after shutdown",
		async () => {
			const actualSpawn = childProcess.spawn;
			if (!actualSpawn) throw new Error("native spawn is unavailable");
			const spawnMock = vi.mocked(spawn);
			let scriptPath: string | undefined;
			let native: ChildProcessType | undefined;
			let watchdog: ChildProcessType | undefined;
			spawnMock.mockImplementation((...args) => {
				const [, argv] = args;
				if (!native) {
					scriptPath = String(argv?.[0]);
					native = actualSpawn(...args);
					return native;
				}
				watchdog = actualSpawn(...args);
				return watchdog;
			});
			try {
				const child = spawnWorkerd(
					process.execPath,
					["-e", 'console.log("READY"); setInterval(()=>{},1000)'],
					{},
				);
				await waitForOutput(child, /READY/);
				if (!native || !watchdog || !scriptPath) throw new Error("supervisor did not spawn");
				const parentDirectory = dirname(scriptPath);
				expect((await fsStat(scriptPath)).mode & 0o077).toBe(0);
				expect((await fsStat(parentDirectory)).mode & 0o077).toBe(0);
				signalWorkerd(native, "SIGTERM");
				expect((await closeWithin(native, 1_500))?.signal).toBe("SIGTERM");
				expect((await closeWithin(watchdog, 1_500))?.code).toBe(0);
				await expect.poll(() => realExistsSync(parentDirectory)).toBe(false);
			} finally {
				spawnMock.mockReset();
				spawnMock.mockImplementation(actualSpawn);
				if (watchdog && watchdog.exitCode === null && watchdog.signalCode === null)
					await terminate(watchdog);
				if (native && native.exitCode === null && native.signalCode === null)
					await terminate(native);
			}
		},
	);
});
