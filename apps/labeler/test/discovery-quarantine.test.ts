import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { quarantineDiscoveryDeadLetters } from "../src/discovery/queue.js";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM discovery_quarantine_events").run();
});

describe("discovery quarantine identity", () => {
	it("retains distinct events that share a Jetstream timestamp", async () => {
		const batch = queueBatch([
			{
				cursor: "900",
				eventId: "event-first",
				orderKey: "order-first",
				event: commitEvent("first"),
			},
			{
				cursor: "900",
				eventId: "event-second",
				orderKey: "order-second",
				event: commitEvent("second"),
			},
		]);

		await quarantineDiscoveryDeadLetters(batch, env);

		const rows = await env.DB.prepare(
			`SELECT cursor, event_id, order_key, revision
			 FROM discovery_quarantine_events
			 ORDER BY event_id`,
		).all<{ cursor: string; event_id: string | null; order_key: string; revision: number }>();
		expect(rows.results).toEqual([
			{ cursor: "900", event_id: "event-first", order_key: "order-first", revision: 1 },
			{ cursor: "900", event_id: "event-second", order_key: "order-second", revision: 1 },
		]);
	});
});

function queueBatch(bodies: readonly unknown[]): MessageBatch {
	return {
		messages: bodies.map((body, index) => ({
			id: `message-${index}`,
			timestamp: new Date("2026-08-25T10:00:00.000Z"),
			body,
			attempts: 5,
			retry() {},
			ack() {},
		})),
		queue: "discovery-dead-letter",
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		retryAll() {},
		ackAll() {},
	};
}

function commitEvent(rkey: string): unknown {
	return {
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
