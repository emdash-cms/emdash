import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	withContentUsageCollectionLock,
	withContentUsageLock,
} from "../../../../src/media/usage/content-lock.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let key = 0;

for (const kind of ["collection", "entry"] as const) {
	describe(`${kind} media usage lock`, () => {
		let collection: string;
		const run = <T>(fn: () => Promise<T>, otherKey = false) =>
			kind === "collection"
				? withContentUsageCollectionLock(otherKey ? `${collection}_other` : collection, fn)
				: withContentUsageLock(collection, otherKey ? "other" : "entry", fn);

		beforeEach(() => {
			vi.useFakeTimers();
			collection = `lock_test_${key++}`;
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("serializes contenders while allowing unrelated keys to proceed", async () => {
			const gate = deferred();
			const owner = run(() => gate.promise);
			const callbacks = [vi.fn(async () => "one"), vi.fn(async () => "two")];
			const waiters = callbacks.map((fn) => run(fn));
			await expect(run(async () => "unrelated", true)).resolves.toBe("unrelated");
			await vi.advanceTimersByTimeAsync(20);
			for (const fn of callbacks) expect(fn).not.toHaveBeenCalled();

			gate.resolve();
			await owner;
			await vi.advanceTimersByTimeAsync(20);
			expect(await Promise.all(waiters)).toEqual(["one", "two"]);
			for (const fn of callbacks) expect(fn).toHaveBeenCalledOnce();
		});

		it("resumes a contender through its own timer after the owner finishes", async () => {
			const gate = deferred();
			const owner = run(() => gate.promise);
			const callback = vi.fn(async () => "waiter");
			const waiter = run(callback);
			gate.resolve();
			await owner;
			// Drain promise reactions without running the waiter's timers.
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(callback).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(20);
			await expect(waiter).resolves.toBe("waiter");
		});

		it("recovers an abandoned owner and keeps a late owner from releasing its replacement", async () => {
			const oldGate = deferred();
			const newGate = deferred();
			const owner = run(() => oldGate.promise);
			const recovered = vi.fn(() => newGate.promise);
			const reclaimer = run(recovered);
			await vi.advanceTimersByTimeAsync(60_020);
			expect(recovered).toHaveBeenCalledOnce();

			oldGate.resolve();
			await owner;
			const lateCallback = vi.fn(async () => "late");
			const late = run(lateCallback);
			await vi.advanceTimersByTimeAsync(20);
			expect(lateCallback).not.toHaveBeenCalled();
			newGate.resolve();
			await reclaimer;
			await vi.advanceTimersByTimeAsync(20);
			await expect(late).resolves.toBe("late");
		});

		it("bounds waiting when successive owners keep the key busy", async () => {
			const busy = (async () => {
				for (let i = 0; i < 4; i++) {
					await run(() => new Promise<void>((resolve) => setTimeout(resolve, 25_000)));
				}
			})();
			const callback = vi.fn(async () => "starved");
			const waiter = run(callback).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(75_020);
			expect(await waiter).toEqual(new Error("Timed out waiting for media usage lock"));
			expect(callback).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(25_000);
			await busy;
		});

		it.each([false, true])("releases after an error (synchronous: %s)", async (synchronous) => {
			const fail = () => {
				if (synchronous) throw new Error("failed work");
				return Promise.reject(new Error("failed work"));
			};
			await expect(run(fail)).rejects.toThrow("failed work");
			await expect(run(async () => "next")).resolves.toBe("next");
		});
	});
}
