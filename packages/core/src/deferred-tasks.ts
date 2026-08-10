export interface DeferredTaskTracker {
	settled: Promise<void>;
	track<T>(promise: Promise<T>): Promise<T>;
	settle(): void;
}

// Test database teardown uses this process-local registry to drain tasks that
// run without request middleware. Keep it on globalThis so duplicated SSR
// chunks and their test helpers observe the same task set.
const DEFERRED_TASKS_KEY = Symbol.for("emdash:deferred-tasks");

const deferredTasks: Set<Promise<unknown>> =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern
	((globalThis as Record<symbol, unknown>)[DEFERRED_TASKS_KEY] as
		| Set<Promise<unknown>>
		| undefined) ??
	(() => {
		const tasks = new Set<Promise<unknown>>();
		(globalThis as Record<symbol, unknown>)[DEFERRED_TASKS_KEY] = tasks;
		return tasks;
	})();

export function trackDeferredTask<T>(promise: Promise<T>): Promise<T> {
	let tracked!: Promise<T>;
	tracked = promise.finally(() => deferredTasks.delete(tracked));
	deferredTasks.add(tracked);
	return tracked;
}

export async function waitForDeferredTasks(): Promise<void> {
	while (deferredTasks.size > 0) {
		await Promise.allSettled(deferredTasks);
	}
}

export function createDeferredTaskTracker(onSettled: () => void): DeferredTaskTracker {
	let pending = 0;
	let responseSettled = false;
	let completed = false;
	let resolveSettled!: () => void;
	const settled = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});

	const completeIfSettled = () => {
		if (completed || !responseSettled || pending > 0) return;
		completed = true;
		try {
			onSettled();
		} finally {
			resolveSettled();
		}
	};

	return {
		settled,
		track<T>(promise: Promise<T>): Promise<T> {
			pending++;
			return promise.finally(() => {
				// A task may register another after() call before it settles. The
				// counter therefore reaches zero only after the full task chain ends.
				pending--;
				completeIfSettled();
			});
		},
		settle(): void {
			responseSettled = true;
			completeIfSettled();
		},
	};
}
