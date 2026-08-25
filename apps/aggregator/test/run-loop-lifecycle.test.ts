import { describe, expect, it, vi } from "vitest";

import { RestartableRunLoop, type ManagedRunLoop } from "../src/run-loop-lifecycle.js";

function deferred(): {
	promise: Promise<void>;
	resolve(): void;
	reject(error: Error): void;
} {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("restartable Durable Object run-loop lifecycle", () => {
	it("anchors constructor restoration and wake runs with waitUntil", () => {
		const waits: Promise<unknown>[] = [];
		const run = deferred();
		const instance: ManagedRunLoop = { run: () => run.promise, stop: run.resolve };
		const lifecycle = new RestartableRunLoop(
			{ waitUntil: (promise) => waits.push(promise) },
			() => instance,
			vi.fn(),
		);

		expect(lifecycle.ensureStarted()).toBe(instance);
		expect(lifecycle.ensureStarted()).toBe(instance);
		expect(waits).toHaveLength(1);
	});

	it("clears a crashed run and reconnects on the next wake", async () => {
		const waits: Promise<unknown>[] = [];
		const crashed = deferred();
		const reconnected = deferred();
		const first: ManagedRunLoop = { run: () => crashed.promise, stop: crashed.resolve };
		const second: ManagedRunLoop = { run: () => reconnected.promise, stop: reconnected.resolve };
		const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
		const onCrash = vi.fn();
		const lifecycle = new RestartableRunLoop(
			{ waitUntil: (promise) => waits.push(promise) },
			create,
			onCrash,
		);

		expect(lifecycle.ensureStarted()).toBe(first);
		crashed.reject(new Error("run loop crashed"));
		await waits[0];
		expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({ message: "run loop crashed" }));
		expect(lifecycle.current).toBeNull();
		expect(lifecycle.ensureStarted()).toBe(second);
		expect(create).toHaveBeenCalledTimes(2);
		expect(waits).toHaveLength(2);
	});

	it("stops and awaits the active run before allowing a restart", async () => {
		const waits: Promise<unknown>[] = [];
		const firstRun = deferred();
		const secondRun = deferred();
		const stop = vi.fn(firstRun.resolve);
		const first: ManagedRunLoop = { run: () => firstRun.promise, stop };
		const second: ManagedRunLoop = { run: () => secondRun.promise, stop: secondRun.resolve };
		const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
		const lifecycle = new RestartableRunLoop(
			{ waitUntil: (promise) => waits.push(promise) },
			create,
			vi.fn(),
		);

		lifecycle.ensureStarted();
		await lifecycle.stopAndWait();
		expect(stop).toHaveBeenCalledOnce();
		expect(lifecycle.current).toBeNull();
		expect(lifecycle.ensureStarted()).toBe(second);
	});
});
