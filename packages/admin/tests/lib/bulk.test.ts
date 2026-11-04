import { describe, expect, it } from "vitest";

import { runBulkAction } from "../../src/lib/bulk";

/** A deferred promise whose resolution the test controls. */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("runBulkAction", () => {
	it("runs every id and reports no failures on success", async () => {
		const seen: string[] = [];
		const result = await runBulkAction(["a", "b", "c"], async (id) => {
			seen.push(id);
		});
		expect(seen.toSorted()).toEqual(["a", "b", "c"]);
		expect(result.failedIds).toEqual([]);
	});

	it("collects failed ids in input order without aborting the rest", async () => {
		const seen: string[] = [];
		const result = await runBulkAction(["a", "b", "c", "d"], async (id) => {
			seen.push(id);
			if (id === "c" || id === "a") throw new Error(`boom ${id}`);
		});
		expect(seen.toSorted()).toEqual(["a", "b", "c", "d"]);
		expect(result.failedIds).toEqual(["a", "c"]);
	});

	it("never exceeds the concurrency limit", async () => {
		const limit = 2;
		let inFlight = 0;
		let maxInFlight = 0;
		const gates = new Map<string, ReturnType<typeof deferred>>();
		const ids = ["a", "b", "c", "d", "e"];
		for (const id of ids) gates.set(id, deferred());

		const run = runBulkAction(
			ids,
			async (id) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await gates.get(id)!.promise;
				inFlight--;
			},
			limit,
		);

		// Release the gates one at a time so the queue has to refill.
		for (const id of ids) {
			// Let the queue start whatever it can before releasing the next gate.
			await new Promise((resolve) => setTimeout(resolve, 0));
			gates.get(id)!.resolve();
		}
		const result = await run;

		expect(maxInFlight).toBeLessThanOrEqual(limit);
		expect(result.failedIds).toEqual([]);
	});

	it("handles an empty id list", async () => {
		const result = await runBulkAction([], () => Promise.resolve());
		expect(result.failedIds).toEqual([]);
	});
});
