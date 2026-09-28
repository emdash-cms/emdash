import { describe, expect, it, vi } from "vitest";

import { DiscoveryStreamIngestor } from "../src/discovery/ingestor.js";

describe("Jetstream discovery queue ingress", () => {
	it("queues relevant commits before durably advancing the source cursor", async () => {
		const log: string[] = [];
		let cursor: string | null = "100";
		const send = vi.fn(async (item: { cursor: string }) => {
			log.push(`queue:${item.cursor}`);
		});
		const ingestor = new DiscoveryStreamIngestor({
			queue: { send },
			cursor: {
				async read() {
					return cursor;
				},
				async advance(expected, next) {
					if (expected !== cursor) return false;
					log.push(`cursor:${next}`);
					cursor = next;
					return true;
				},
			},
		});
		await ingestor.consume(
			stream([
				{
					time_us: 101,
					kind: "commit",
					did: "did:plc:fixture",
					commit: {
						operation: "create",
						collection: "com.emdashcms.experimental.package.profile",
						rkey: "demo",
						cid: "bafyfixture",
					},
				},
				{ time_us: 102, kind: "identity", did: "did:plc:fixture", identity: {} },
			]),
		);
		expect(log).toEqual(["queue:101", "cursor:101", "cursor:102"]);
		expect(send).toHaveBeenCalledOnce();
	});

	it("does not advance when the queue rejects a relevant event", async () => {
		const advance = vi.fn(async () => true);
		const ingestor = new DiscoveryStreamIngestor({
			queue: {
				async send() {
					throw new Error("queue unavailable");
				},
			},
			cursor: { read: async () => null, advance },
		});
		await expect(
			ingestor.consume(
				stream([
					{
						time_us: 103,
						kind: "commit",
						did: "did:plc:fixture",
						commit: {
							operation: "update",
							collection: "com.emdashcms.experimental.package.release",
							rkey: "demo:1.0.0",
							cid: "bafyfixture",
						},
					},
				]),
			),
		).rejects.toThrow(/queue unavailable/);
		expect(advance).not.toHaveBeenCalled();
	});

	it("queues distinct commits that share the same Jetstream timestamp", async () => {
		let cursor: string | null = "200";
		const sent: Array<{ cursor: string; eventId?: string }> = [];
		const ingestor = new DiscoveryStreamIngestor({
			queue: {
				async send(item) {
					sent.push(item);
				},
			},
			cursor: {
				read: async () => cursor,
				async advance(expected, next) {
					if (expected !== cursor) return false;
					cursor = next;
					return true;
				},
			},
		});
		await ingestor.consume(stream([commitEvent(201, "first"), commitEvent(201, "second")]));
		expect(sent).toHaveLength(2);
		expect(sent[0]?.cursor).toBe("201");
		expect(sent[1]?.cursor).toBe("201");
		expect(sent[0]?.eventId).not.toBe(sent[1]?.eventId);
	});
});

function commitEvent(time: number, rkey: string) {
	return {
		time_us: time,
		kind: "commit",
		did: "did:plc:fixture",
		commit: {
			operation: "create",
			collection: "com.emdashcms.experimental.package.profile",
			rkey,
			cid: `bafy${rkey}`,
		},
	};
}

async function* stream(events: readonly unknown[]) {
	for (const event of events) yield event;
}
