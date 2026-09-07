import { describe, expect, it } from "vitest";

import type { AssessmentLifecycleStore } from "../src/assessment/lifecycle.js";
import { consumeDiscoveryItems } from "../src/discovery/consumer.js";
import type { DiscoveryQuarantineStore } from "../src/discovery/consumer.js";
import type { DiscoveryCursorStore } from "../src/discovery/cursor.js";
import { ASSESSMENT_VERSIONS, PROFILE_CID, PUBLISHER_DID } from "./assessment-fixtures.js";

function createCursorStore(log: string[]): DiscoveryCursorStore {
	let cursor: string | null = null;
	return {
		async read() {
			return cursor;
		},
		async advance(expected, next) {
			if (expected !== cursor) return false;
			log.push(`cursor:${next}`);
			cursor = next;
			return true;
		},
	};
}

function createLifecycle(log: string[]): AssessmentLifecycleStore {
	return {
		async observeRun({ params }) {
			log.push(`observe:${params.subjectCid}`);
			return {
				runKey: params.runKey,
				subject: { uri: params.subjectUri, cid: params.subjectCid, kind: params.subjectKind },
				state: "pending",
				stateVersion: 0,
				deleted: false,
			};
		},
		async getRun() {
			return null;
		},
		async startRun() {
			throw new Error("not used");
		},
		async persistPrepared() {
			throw new Error("not used");
		},
		async finalizeRun() {
			throw new Error("not used");
		},
		async cancelSubject(uri) {
			log.push(`cancel:${uri}`);
		},
	};
}

function createQuarantine(log: string[]): DiscoveryQuarantineStore {
	return {
		async write(entry) {
			log.push(`quarantine:${entry.cursor}`);
		},
	};
}

describe("record discovery dispatch", () => {
	it("uses event envelopes only as hints and advances after direct Workflow creation", async () => {
		const log: string[] = [];
		const batches: Array<Array<{ id: string; params: unknown }>> = [];
		const dependencies = {
			workflow: {
				async createBatch(batch: Array<{ id: string; params: unknown }>) {
					log.push("workflow");
					batches.push(batch);
					return [];
				},
			},
			cursor: createCursorStore(log),
			lifecycle: createLifecycle(log),
			quarantine: createQuarantine(log),
			versions: ASSESSMENT_VERSIONS,
			now: () => new Date("2026-08-24T10:00:00.000Z"),
		};
		const event = {
			did: PUBLISHER_DID,
			kind: "commit",
			commit: {
				operation: "create",
				collection: "com.emdashcms.experimental.package.profile",
				rkey: "gallery",
				cid: PROFILE_CID,
				record: { name: "forged event body must be ignored", label: "listing-passed" },
			},
		};
		const first = await consumeDiscoveryItems([{ cursor: "100", event }], dependencies);
		expect(first.dispatchedRunKeys).toHaveLength(1);
		expect(log).toEqual([`observe:${PROFILE_CID}`, "workflow", "cursor:100"]);
		expect(JSON.stringify(batches)).not.toContain("forged event body");
		expect(JSON.stringify(batches)).not.toContain("listing-passed");

		const duplicate = await consumeDiscoveryItems([{ cursor: "100", event }], dependencies);
		expect(duplicate.dispatchedRunKeys).toEqual([]);
		expect(batches).toHaveLength(1);
	});

	it("quarantines delete hints for authoritative reconciliation before advancing", async () => {
		const log: string[] = [];
		await consumeDiscoveryItems(
			[
				{
					cursor: "101",
					event: {
						did: PUBLISHER_DID,
						kind: "commit",
						commit: {
							operation: "delete",
							collection: "com.emdashcms.experimental.package.profile",
							rkey: "gallery",
						},
					},
				},
			],
			{
				workflow: {
					async createBatch() {
						return [];
					},
				},
				cursor: createCursorStore(log),
				lifecycle: createLifecycle(log),
				quarantine: createQuarantine(log),
				versions: ASSESSMENT_VERSIONS,
			},
		);
		expect(log).toEqual(["quarantine:101", "cursor:101"]);
	});

	it("quarantines malformed relevant events before advancing for reconciliation", async () => {
		const log: string[] = [];
		const entries: Parameters<DiscoveryQuarantineStore["write"]>[0][] = [];
		const result = await consumeDiscoveryItems(
			[
				{
					cursor: "102",
					event: {
						did: PUBLISHER_DID,
						kind: "commit",
						commit: {
							operation: "create",
							collection: "com.emdashcms.experimental.package.profile",
							rkey: "gallery",
							cid: "bafyinvalid!punctuation",
							record: { secret: "unbounded publisher body" },
						},
					},
				},
			],
			{
				workflow: {
					async createBatch() {
						return [];
					},
				},
				cursor: createCursorStore(log),
				lifecycle: createLifecycle(log),
				quarantine: {
					async write(entry) {
						entries.push(entry);
						log.push(`quarantine:${entry.cursor}`);
					},
				},
				versions: ASSESSMENT_VERSIONS,
			},
		);
		expect(log).toEqual(["quarantine:102", "cursor:102"]);
		expect(result.quarantinedCursors).toEqual(["102"]);
		expect(entries[0]).toMatchObject({ requiresReconciliation: true });
		expect(entries[0]?.eventSummary).not.toContain("unbounded publisher body");
	});

	it("does not quarantine or advance on an infrastructure failure", async () => {
		const log: string[] = [];
		const lifecycle = createLifecycle(log);
		lifecycle.observeRun = async () => {
			throw new Error("D1 unavailable");
		};
		await expect(
			consumeDiscoveryItems(
				[
					{
						cursor: "103",
						event: {
							did: PUBLISHER_DID,
							kind: "commit",
							commit: {
								operation: "create",
								collection: "com.emdashcms.experimental.package.profile",
								rkey: "gallery",
								cid: PROFILE_CID,
							},
						},
					},
				],
				{
					workflow: {
						async createBatch() {
							return [];
						},
					},
					cursor: createCursorStore(log),
					lifecycle,
					quarantine: createQuarantine(log),
					versions: ASSESSMENT_VERSIONS,
				},
			),
		).rejects.toThrow(/D1 unavailable/);
		expect(log).toEqual([]);
	});
});
