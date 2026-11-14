import type { ChildProcess } from "node:child_process";
import { existsSync as realExistsSync } from "node:fs";
import { execPath } from "node:process";

import { describe, expect, it, vi } from "vitest";

const { shellOverride } = vi.hoisted(() => ({
	shellOverride: { value: undefined as boolean | undefined },
}));

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
	child: ChildProcess,
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

async function terminate(child: ChildProcess): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) signalWorkerd(child, "SIGKILL");
	await closeWithin(child);
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
					new RegExp(`code 127.*${missing.replaceAll("/", "\\/")}`),
				);
			} finally {
				await terminate(child);
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
});
