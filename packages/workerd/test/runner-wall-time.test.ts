import { readdir, readFile } from "node:fs/promises";

import type { PluginManifest } from "emdash";
import { describe, expect, it, vi } from "vitest";

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

const slowIoManifest = (id: string): PluginManifest => ({
	id,
	version: "1.0.0",
	capabilities: ["network:request:unrestricted"],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: ["fetch"],
	admin: {},
});

const slowIoPlugin = `export default {
	routes: {
		fetch: { handler: async ({ input }, ctx) => {
			const response = await ctx.http.fetch(input.url);
			return response.text();
		} }
	}
};`;

const yieldingLoopPlugin = `export default {
	routes: {
		loop: { handler: async (_input, ctx) => {
			for (;;) {
				let work = 0;
				for (let i = 0; i < 10000; i++) work += i;
				if (work < 0) throw new Error("unreachable");
				await ctx.http.fetch("https://93.184.216.34/yield");
			}
		} },
		ping: { handler: async () => ({ plugin: "yielding", ok: true }) }
	}
};`;

const slowThenSpinPlugin = `export default {
	routes: {
		fetch: { handler: async ({ input }, ctx) => {
			await ctx.http.fetch(input.url);
			for (;;) {}
		} },
		ping: { handler: async () => ({ plugin: "slow-spin", ok: true }) }
	}
};`;

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

				expect(await loop.invokeRoute("ping", {}, request)).toEqual({ plugin: "loop", ok: true });
				if (process.platform === "linux") {
					await expect.poll(() => runningPids(oldPids), { timeout: 1000 }).toEqual(new Set());
				}
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

	it("restarts after a yielding loop remains unsettled past the grace period", async () => {
		const wallTimeMs = 1000;
		let readyProbeCount = 0;
		const originalFetch = globalThis.fetch;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const response = await originalFetch(input, init);
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("/__ready")) readyProbeCount++;
			return response;
		});
		const runner = new WorkerdSandboxRunner({
			db: null as never,
			limits: { wallTimeMs },
			httpFetch: async () => new Response("yield"),
		});
		let oldPids = new Set<number>();
		let loopCall: Promise<unknown> | undefined;
		try {
			const loop = await runner.load(
				{ ...loopManifest, capabilities: ["network:request:unrestricted"] },
				yieldingLoopPlugin,
			);
			const second = await runner.load(secondManifest, secondPlugin);
			await runner.ensureRunning();
			const oldProcess = runner["workerdProcess"];
			const oldEpoch = runner["epoch"];
			if (!oldProcess?.pid) throw new Error("workerd did not start");
			oldPids = await descendants(oldProcess.pid);
			oldPids.add(oldProcess.pid);
			readyProbeCount = 0;

			loopCall = loop.invokeRoute("loop", {}, request);
			void loopCall.catch(() => {});
			await expect(loopCall).rejects.toThrow(
				"Plugin wall-time-loop exceeded wall-time limit of 1000ms during route:loop",
			);
			const recoveryDeadline = Date.now() + wallTimeMs + 3000;
			await expect.poll(() => readyProbeCount, { timeout: 1000 }).toBeGreaterThan(0);
			expect(runner["workerdProcess"]).toBe(oldProcess);
			await expect
				.poll(() => runner["epoch"], { timeout: Math.max(1, recoveryDeadline - Date.now()) })
				.toBeGreaterThan(oldEpoch);
			expect(runner["workerdProcess"]).not.toBe(oldProcess);
			if (process.platform === "linux") {
				await expect.poll(() => runningPids(oldPids), { timeout: 1000 }).toEqual(new Set());
			}
			expect(await loop.invokeRoute("ping", {}, request)).toEqual({ plugin: "yielding", ok: true });
			expect(await second.invokeRoute("ping", {}, request)).toEqual({
				plugin: "second",
				ok: true,
			});
		} finally {
			killPids(oldPids);
			await loopCall?.catch(() => {});
			fetchSpy.mockRestore();
			await runner.terminateAll();
		}
	}, 15_000);

	it("restarts when slow I/O enters a CPU loop after the grace probe", async () => {
		const wallTimeMs = 1000;
		let releaseSlowFetch!: () => void;
		const slowFetch = new Promise<void>((resolve) => {
			releaseSlowFetch = resolve;
		});
		let slowFetchStarted!: () => void;
		const slowFetchStartedPromise = new Promise<void>((resolve) => {
			slowFetchStarted = resolve;
		});
		let readyProbeCount = 0;
		const originalFetch = globalThis.fetch;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const response = await originalFetch(input, init);
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("/__ready")) readyProbeCount++;
			return response;
		});
		const runner = new WorkerdSandboxRunner({
			db: null as never,
			limits: { wallTimeMs },
			httpFetch: async (input) => {
				const url = input instanceof Request ? input.url : input.toString();
				if (url.endsWith("/slow-spin")) {
					slowFetchStarted();
					await slowFetch;
				}
				return new Response("released");
			},
		});
		let oldPids = new Set<number>();
		let slowCall: Promise<unknown> | undefined;
		try {
			const slowSpinManifest = {
				...slowIoManifest("wall-time-slow-spin"),
				routes: ["fetch", "ping"],
			} satisfies PluginManifest;
			const slow = await runner.load(slowSpinManifest, slowThenSpinPlugin);
			const second = await runner.load(secondManifest, secondPlugin);
			await runner.ensureRunning();
			const oldProcess = runner["workerdProcess"];
			const oldEpoch = runner["epoch"];
			if (!oldProcess?.pid) throw new Error("workerd did not start");
			oldPids = await descendants(oldProcess.pid);
			oldPids.add(oldProcess.pid);
			readyProbeCount = 0;

			slowCall = slow.invokeRoute("fetch", { url: "https://93.184.216.34/slow-spin" }, request);
			void slowCall.catch(() => {});
			await Promise.race([slowFetchStartedPromise, slowCall]);
			await expect(slowCall).rejects.toThrow(
				"Plugin wall-time-slow-spin exceeded wall-time limit of 1000ms during route:fetch",
			);
			const recoveryDeadline = Date.now() + wallTimeMs + 3000;
			await expect.poll(() => readyProbeCount, { timeout: 1000 }).toBeGreaterThan(0);
			expect(runner["workerdProcess"]).toBe(oldProcess);
			releaseSlowFetch();
			await expect
				.poll(() => runner["epoch"], { timeout: Math.max(1, recoveryDeadline - Date.now()) })
				.toBeGreaterThan(oldEpoch);
			expect(runner["workerdProcess"]).not.toBe(oldProcess);
			if (process.platform === "linux") {
				await expect.poll(() => runningPids(oldPids), { timeout: 1000 }).toEqual(new Set());
			}
			expect(await slow.invokeRoute("ping", {}, request)).toEqual({
				plugin: "slow-spin",
				ok: true,
			});
			expect(await second.invokeRoute("ping", {}, request)).toEqual({
				plugin: "second",
				ok: true,
			});
		} finally {
			releaseSlowFetch();
			killPids(oldPids);
			await slowCall?.catch(() => {});
			fetchSpy.mockRestore();
			await runner.terminateAll();
		}
	}, 15_000);

	it("keeps workerd alive when a timed-out plugin is waiting on I/O", async () => {
		let releaseSlowFetch!: () => void;
		const slowFetch = new Promise<void>((resolve) => {
			releaseSlowFetch = resolve;
		});
		let releaseFastFetch!: () => void;
		const fastFetch = new Promise<void>((resolve) => {
			releaseFastFetch = resolve;
		});
		let slowFetchStarted!: () => void;
		const slowFetchStartedPromise = new Promise<void>((resolve) => {
			slowFetchStarted = resolve;
		});
		let fastFetchStarted!: () => void;
		const fastFetchStartedPromise = new Promise<void>((resolve) => {
			fastFetchStarted = resolve;
		});
		let readyProbeCount = 0;
		const originalFetch = globalThis.fetch;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const response = await originalFetch(input, init);
			if (typeof input === "string" && input.includes("/__ready")) {
				readyProbeCount++;
			}
			return response;
		});
		const runner = new WorkerdSandboxRunner({
			db: null as never,
			limits: { wallTimeMs: 1000 },
			httpFetch: async (input) => {
				const url = input instanceof Request ? input.url : input.toString();
				if (url.endsWith("/slow")) {
					slowFetchStarted();
					await slowFetch;
					return new Response("slow");
				}
				fastFetchStarted();
				await fastFetch;
				return new Response("fast");
			},
		});
		let slowCall: Promise<unknown> | undefined;
		let fastCall: Promise<unknown> | undefined;
		try {
			const slowPlugin = await runner.load(slowIoManifest("wall-time-slow-io"), slowIoPlugin);
			const fastPlugin = await runner.load(slowIoManifest("wall-time-fast-io"), slowIoPlugin);
			await runner.ensureRunning();
			const originalProcess = runner["workerdProcess"];
			const originalEpoch = runner["epoch"];
			if (!originalProcess) throw new Error("workerd did not start");
			readyProbeCount = 0;

			slowCall = slowPlugin.invokeRoute("fetch", { url: "https://93.184.216.34/slow" }, request);
			void slowCall.catch(() => {});
			await Promise.race([slowFetchStartedPromise, slowCall]);
			await new Promise((resolve) => setTimeout(resolve, 500));
			fastCall = fastPlugin.invokeRoute("fetch", { url: "https://93.184.216.34/fast" }, request);
			void fastCall.catch(() => {});
			await Promise.race([fastFetchStartedPromise, fastCall]);

			await expect(slowCall).rejects.toThrow(
				"Plugin wall-time-slow-io exceeded wall-time limit of 1000ms during route:fetch",
			);
			await expect.poll(() => readyProbeCount, { timeout: 1000 }).toBeGreaterThan(0);
			releaseFastFetch();
			await expect(fastCall).resolves.toBe("fast");
			releaseSlowFetch();
			await new Promise((resolve) => setTimeout(resolve, 1200));
			expect(runner["workerdProcess"]).toBe(originalProcess);
			expect(runner["epoch"]).toBe(originalEpoch);
		} finally {
			releaseSlowFetch();
			releaseFastFetch();
			await slowCall?.catch(() => {});
			await fastCall?.catch(() => {});
			fetchSpy.mockRestore();
			await runner.terminateAll();
		}
	}, 15_000);
});
