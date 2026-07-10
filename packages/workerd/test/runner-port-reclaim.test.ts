/**
 * Plugin Port Reclaim Tests
 *
 * Regression coverage for an unbounded-port-growth bug in
 * `WorkerdSandboxRunner`: `load()` allocated plugin ports via
 * `this.nextPluginPort++`, but `unloadPlugin()` only deleted the entry
 * from the map without ever returning the port. A long-running site
 * with frequent marketplace install/uninstall (or dev watcher reloads)
 * would keep climbing toward 65535 and could collide with whatever
 * else the host happened to be listening on.
 *
 * The fix maintains a `freePorts` pool: `unloadPlugin()` pushes the
 * port back, and `load()` prefers a recycled port over allocating a
 * fresh one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

function stubManifest(id: string) {
	return {
		id,
		name: id,
		version: "1.0.0",
		capabilities: [],
		storage: {},
	} as any;
}

describe("plugin port reclaim", () => {
	let runner: WorkerdSandboxRunner;

	beforeEach(() => {
		vi.useFakeTimers();
		runner = new WorkerdSandboxRunner({ db: null as any });
		// Stub ensureRunning so the debounced eager-start timer body (if it
		// ever fires) doesn't try to actually spawn workerd.
		vi.spyOn(runner as any, "ensureRunning").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		try {
			await runner.terminateAll();
		} catch {
			// best-effort cleanup -- ensureRunning is stubbed
		}
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("reuses ports freed by unload", async () => {
		const p1 = await runner.load(stubManifest("a"), "export default {};");
		const p2 = await runner.load(stubManifest("b"), "export default {};");
		const port1 = (p1 as any).port;
		const port2 = (p2 as any).port;
		expect(port2).toBeGreaterThan(port1);

		runner.unloadPlugin("a:1.0.0");

		const p3 = await runner.load(stubManifest("c"), "export default {};");
		const port3 = (p3 as any).port;
		// p3 should reuse the port freed by p1, not climb past port2.
		expect(port3).toBe(port1);
	});

	it("does not grow nextPluginPort across repeated load/unload cycles", async () => {
		await runner.load(stubManifest("x"), "export default {};");
		await runner.load(stubManifest("y"), "export default {};");
		runner.unloadPlugin("x:1.0.0");
		runner.unloadPlugin("y:1.0.0");

		// Capture nextPluginPort after the initial allocations.
		const before = (runner as any).nextPluginPort;

		for (let i = 0; i < 10; i++) {
			const p = await runner.load(stubManifest(`p${i}`), "export default {};");
			runner.unloadPlugin(`p${i}:1.0.0`);
			void p; // keep tsc happy
		}

		const after = (runner as any).nextPluginPort;
		// Ten load/unload cycles should have entirely reused freed ports.
		expect(after).toBe(before);
	});
});
