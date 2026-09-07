import { describe, expect, test } from "vitest";

import {
	extractInvestigationResult,
	waitForResult,
	type Snapshot,
} from "../../evals/src/client.ts";

const REPORTED = {
	result: { reproduced: true, summary: "reproduced the bug" },
	ok: true,
	pushed: false,
	runId: "run-1",
	publication: null,
	verification: [],
};

describe("extractInvestigationResult", () => {
	test("finds the reported payload nested in a snapshot data part", () => {
		const snapshot = {
			messages: [
				{ role: "assistant", parts: [{ type: "text", text: "done" }] },
				{ role: "assistant", parts: [{ type: "data", name: "investigation", data: REPORTED }] },
			],
		};
		expect(extractInvestigationResult(snapshot)).toEqual(REPORTED);
	});

	test("finds the payload when it arrives as a stringified tool output", () => {
		const snapshot = { parts: [{ type: "tool-result", output: JSON.stringify(REPORTED) }] };
		expect(extractInvestigationResult(snapshot)).toEqual(REPORTED);
	});

	test("returns the last reported payload when several are present", () => {
		const first = { result: { reproduced: false, summary: "first pass" }, ok: true, pushed: false };
		const snapshot = { a: { data: first }, b: { data: REPORTED } };
		expect(extractInvestigationResult(snapshot)).toEqual(REPORTED);
	});

	test("returns null when no payload is present", () => {
		expect(extractInvestigationResult({ messages: [{ text: "still working" }] })).toBeNull();
	});

	test("ignores a partial object missing ok/pushed", () => {
		expect(extractInvestigationResult({ result: { summary: "x" } })).toBeNull();
	});
});

describe("waitForResult", () => {
	const endpoint = { baseUrl: "https://worker.test", token: "t" };

	test("resolves once the reported payload appears", async () => {
		const snapshots: Snapshot[] = [
			{ settlements: [] },
			{ settlements: [], messages: [{ data: REPORTED }] },
		];
		let call = 0;
		const result = await waitForResult(endpoint, "eval-917-x", {
			timeoutMs: 10_000,
			pollMs: 0,
			now: () => 0,
			sleep: async () => {},
			fetchSnapshot: async () => snapshots[Math.min(call++, snapshots.length - 1)]!,
		});
		expect(result).toEqual(REPORTED);
	});

	test("returns null when the run settles with no verdict", async () => {
		const result = await waitForResult(endpoint, "eval-917-x", {
			timeoutMs: 10_000,
			pollMs: 0,
			now: () => 0,
			sleep: async () => {},
			fetchSnapshot: async () => ({ settlements: [{ done: true }] }),
		});
		expect(result).toBeNull();
	});

	test("throws once the deadline passes without a verdict", async () => {
		let clock = 0;
		await expect(
			waitForResult(endpoint, "eval-917-x", {
				timeoutMs: 100,
				pollMs: 10,
				now: () => (clock += 60),
				sleep: async () => {},
				fetchSnapshot: async () => ({ settlements: [] }),
			}),
		).rejects.toThrow(/timed out/);
	});
});
