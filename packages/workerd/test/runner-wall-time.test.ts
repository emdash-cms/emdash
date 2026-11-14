import { readdir, readFile } from "node:fs/promises";

import type { PluginManifest } from "emdash";
import { describe, expect, it } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

let workerdAvailable = false;
try {
	const runner = new WorkerdSandboxRunner({ db: null as never });
	workerdAvailable = runner.isAvailable();
	await runner.terminateAll();
} catch {
	// The optional workerd binary is not installed in every test environment.
}

const loopManifest: PluginManifest = {
	id: "wall-time-loop",
	version: "1.0.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: ["loop"],
	routes: ["loop", "ping"],
	admin: {},
};

const secondManifest: PluginManifest = {
	...loopManifest,
	id: "wall-time-second-plugin",
	hooks: [],
	routes: ["ping"],
};

const loopPlugin = `export default {
	hooks: { loop: { handler: async () => { for (;;) {} } } },
	routes: {
		loop: { handler: async () => { for (;;) {} } },
		ping: { handler: async () => ({ plugin: "loop", ok: true }) }
	}
};`;

const secondPlugin = `export default {
	routes: { ping: { handler: async () => ({ plugin: "second", ok: true }) } }
};`;

const request = { method: "POST", url: "/test", headers: {} };

type Operation = "route" | "hook";

async function procPids(): Promise<number[]> {
	if (process.platform !== "linux") return [];
	const entries = await readdir("/proc", { withFileTypes: true });
	return entries.filter((entry) => /^\d+$/.test(entry.name)).map((entry) => Number(entry.name));
}

async function parentPid(pid: number): Promise<number | null> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const afterComm = stat.lastIndexOf(")");
		const fields = stat.slice(afterComm + 2).split(" ");
		return Number(fields[1]);
	} catch {
		return null;
	}
}

async function descendants(rootPid: number): Promise<Set<number>> {
	if (process.platform !== "linux") return new Set();
	const pids = await procPids();
	const parents = await Promise.all(pids.map(async (pid) => [pid, await parentPid(pid)] as const));
	const children = new Map<number, number[]>();
	for (const [pid, ppid] of parents) {
		if (ppid === null) continue;
		const list = children.get(ppid) ?? [];
		list.push(pid);
		children.set(ppid, list);
	}
	const result = new Set<number>();
	const pending = [...(children.get(rootPid) ?? [])];
	while (pending.length > 0) {
		const pid = pending.pop()!;
		if (result.has(pid)) continue;
		result.add(pid);
		pending.push(...(children.get(pid) ?? []));
	}
	return result;
}

async function runningPids(pids: Set<number>): Promise<Set<number>> {
	const running = new Set<number>();
	for (const pid of pids) {
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const afterComm = stat.lastIndexOf(")");
			if (stat.slice(afterComm + 2, afterComm + 3) !== "Z") running.add(pid);
		} catch {
			// The process exited between discovery and inspection.
		}
	}
	return running;
}

function killPids(pids: Set<number>): void {
	if (process.platform !== "linux") return;
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The process may have exited already.
		}
	}
}

describe.skipIf(!workerdAvailable)("workerd wall-time process isolation", () => {
	it.each<Operation>(["route", "hook"])(
		"kills the isolate and restarts with all plugins after a %s timeout",
		async (operation) => {
			const runner = new WorkerdSandboxRunner({ db: null as never, limits: { wallTimeMs: 300 } });
			let oldPids = new Set<number>();
			try {
				const loop = await runner.load(loopManifest, loopPlugin);
				const second = await runner.load(secondManifest, secondPlugin);
				await runner.ensureRunning();
				const oldProcess = runner["workerdProcess"];
				if (!oldProcess?.pid) throw new Error("workerd did not start");
				oldPids = await descendants(oldProcess.pid);
				oldPids.add(oldProcess.pid);

				if (operation === "route") {
					await expect(loop.invokeRoute("loop", {}, request)).rejects.toThrow(
						"Plugin wall-time-loop exceeded wall-time limit of 300ms during route:loop",
					);
				} else {
					await expect(loop.invokeHook("loop", {})).rejects.toThrow(
						"Plugin wall-time-loop exceeded wall-time limit of 300ms during hook:loop",
					);
				}

				if (process.platform === "linux") {
					await expect.poll(() => runningPids(oldPids), { timeout: 1000 }).toEqual(new Set());
				}
				expect(await loop.invokeRoute("ping", {}, request)).toEqual({ plugin: "loop", ok: true });
				expect(await second.invokeRoute("ping", {}, request)).toEqual({
					plugin: "second",
					ok: true,
				});
			} finally {
				killPids(oldPids);
				await runner.terminateAll();
			}
		},
		15_000,
	);
});
