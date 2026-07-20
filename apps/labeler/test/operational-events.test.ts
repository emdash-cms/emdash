import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
	buildOperationalEventInsert,
	buildOutboxInsert,
	getOperationalEvents,
	getOperationalEventsByActionId,
	getOutboxForEvent,
	newOperationalEventId,
	type OperationalEventInsert,
} from "../src/operational-events.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

let counter = 0;

function eventInput(overrides: Partial<OperationalEventInsert> = {}): OperationalEventInsert {
	counter++;
	return {
		id: newOperationalEventId(),
		eventType: "emergency-takedown",
		severity: "critical",
		actionId: null,
		subjectUri: `did:plc:publisher${counter}`,
		labelValue: "!takedown",
		payload: { reason: `incident ${counter}` },
		now: new Date("2026-07-13T00:00:00.000Z"),
		...overrides,
	};
}

/** Seeds an `operator_actions` row so an event's `action_id` FK resolves. */
async function insertOperatorAction(id: string): Promise<void> {
	await testEnv.DB.prepare(
		`INSERT INTO operator_actions
		 (id, actor_type, actor_id, role, action, reason, idempotency_key,
		  request_fingerprint, created_at, created_at_epoch_ms)
		 VALUES (?, 'human', 'u', 'admin', 'takedown', 'r', ?, 'fp',
		         '2026-07-13T00:00:00.000Z', 0)`,
	)
		.bind(id, `key-${id}`)
		.run();
}

/**
 * Inserts an `issued_labels` row (via its `issuance_actions` parent) carrying
 * the given `action_id`, so the gated builders' `WHERE EXISTS` sees a label.
 */
async function insertIssuedLabel(actionId: number): Promise<void> {
	await testEnv.DB.prepare(
		`INSERT INTO issuance_actions (id, actor, type, reason, idempotency_key, created_at)
		 VALUES (?, ?, 'manual-label', 'takedown', ?, '2026-07-13T00:00:00.000Z')`,
	)
		.bind(actionId, "did:web:labels.emdashcms.com", `gate-key-${actionId}`)
		.run();
	await testEnv.DB.prepare(
		`INSERT INTO issued_labels (action_id, ver, src, uri, val, cts, sig, signing_key_id)
		 VALUES (?, 1, 'did:web:labels.emdashcms.com', 'did:plc:sub', '!takedown',
		         '2026-07-13T00:00:00.000Z', X'00', 'did:web:labels.emdashcms.com#atproto_label')`,
	)
		.bind(actionId)
		.run();
}

describe("operational_events store", () => {
	it("inserts and reads back an event newest-first", async () => {
		const input = eventInput({ severity: "high", eventType: "automation-paused" });
		await buildOperationalEventInsert(testEnv.DB, input).run();

		const [stored] = await getOperationalEvents(testEnv.DB, { limit: 1 });
		expect(stored).toMatchObject({
			id: input.id,
			eventType: "automation-paused",
			severity: "high",
			subjectUri: input.subjectUri,
			labelValue: "!takedown",
			payloadJson: JSON.stringify(input.payload),
		});
	});

	it("stores a null action_id, subject, and label for a system event", async () => {
		const input = eventInput({
			eventType: "automation-resumed",
			severity: "info",
			actionId: null,
			subjectUri: null,
			labelValue: null,
			payload: {},
		});
		await buildOperationalEventInsert(testEnv.DB, input).run();

		const [stored] = await getOperationalEvents(testEnv.DB, { limit: 1 });
		expect(stored).toMatchObject({
			actionId: null,
			subjectUri: null,
			labelValue: null,
			payloadJson: "{}",
		});
	});

	it("reads events by action id", async () => {
		const actionId = `oact_events${counter}`;
		const otherId = `oact_other${counter}`;
		await insertOperatorAction(actionId);
		await insertOperatorAction(otherId);
		// One action can raise events of DIFFERENT types (a takedown emits both
		// `emergency-takedown` and the deferred `takedown-no-contact`); the
		// (action_id, event_type) unique index forbids the SAME type twice.
		await buildOperationalEventInsert(testEnv.DB, eventInput({ actionId })).run();
		await buildOperationalEventInsert(
			testEnv.DB,
			eventInput({ actionId, eventType: "takedown-no-contact" }),
		).run();
		await buildOperationalEventInsert(testEnv.DB, eventInput({ actionId: otherId })).run();

		const rows = await getOperationalEventsByActionId(testEnv.DB, actionId);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.actionId === actionId)).toBe(true);
	});

	it("allows duplicate (action_id, event_type) for a non-takedown event type", async () => {
		// The 0012 unique index is PARTIAL to `takedown-no-contact`, so historical
		// duplicates of other types are unconstrained — this is what keeps the
		// migration safe on existing data.
		const actionId = `oact_dup${counter}`;
		await insertOperatorAction(actionId);
		await buildOperationalEventInsert(
			testEnv.DB,
			eventInput({ actionId, eventType: "emergency-takedown" }),
		).run();
		await buildOperationalEventInsert(
			testEnv.DB,
			eventInput({ actionId, eventType: "emergency-takedown" }),
		).run();

		const rows = await getOperationalEventsByActionId(testEnv.DB, actionId);
		expect(rows).toHaveLength(2);
	});

	it("collapses a second takedown-no-contact for the same action to a no-op", async () => {
		const actionId = `oact_tnc${counter}`;
		await insertOperatorAction(actionId);
		const input = () =>
			eventInput({ actionId, eventType: "takedown-no-contact", idempotentTakedownNoContact: true });
		await buildOperationalEventInsert(testEnv.DB, input()).run();
		await buildOperationalEventInsert(testEnv.DB, input()).run();

		const rows = await getOperationalEventsByActionId(testEnv.DB, actionId);
		expect(rows).toHaveLength(1);
	});

	it("rejects UPDATE on a recorded event (immutable log)", async () => {
		const input = eventInput();
		await buildOperationalEventInsert(testEnv.DB, input).run();

		await expect(
			testEnv.DB.prepare("UPDATE operational_events SET severity = 'info' WHERE id = ?")
				.bind(input.id)
				.run(),
		).rejects.toThrow(/immutable/);
	});

	it("rejects DELETE on a recorded event (immutable log)", async () => {
		const input = eventInput();
		await buildOperationalEventInsert(testEnv.DB, input).run();

		await expect(
			testEnv.DB.prepare("DELETE FROM operational_events WHERE id = ?").bind(input.id).run(),
		).rejects.toThrow(/immutable/);
	});
});

describe("label-gated event + outbox inserts", () => {
	it("inserts the event and outbox row when the gated label exists", async () => {
		const gateActionId = 8001;
		await insertIssuedLabel(gateActionId);

		const input = eventInput({ gateOnIssuedLabelActionId: gateActionId });
		await buildOperationalEventInsert(testEnv.DB, input).run();
		await buildOutboxInsert(testEnv.DB, {
			eventId: input.id,
			channel: "deployment-alert",
			now: input.now,
			gateOnIssuedLabelActionId: gateActionId,
		}).run();

		const eventCount = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM operational_events WHERE id = ?`,
		)
			.bind(input.id)
			.first<{ n: number }>();
		expect(eventCount?.n).toBe(1);

		const outbox = await getOutboxForEvent(testEnv.DB, input.id);
		expect(outbox).toHaveLength(1);
		expect(outbox[0]).toMatchObject({
			eventId: input.id,
			channel: "deployment-alert",
			state: "pending",
			attempts: 0,
		});
	});

	it("inserts neither event nor outbox row when the gated label is absent", async () => {
		const gateActionId = 9999; // no issued_labels row references this
		const input = eventInput({ gateOnIssuedLabelActionId: gateActionId });

		await buildOperationalEventInsert(testEnv.DB, input).run();
		await buildOutboxInsert(testEnv.DB, {
			eventId: input.id,
			channel: "deployment-alert",
			now: input.now,
			gateOnIssuedLabelActionId: gateActionId,
		}).run();

		const eventCount = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM operational_events WHERE id = ?`,
		)
			.bind(input.id)
			.first<{ n: number }>();
		expect(eventCount?.n).toBe(0);

		const outbox = await getOutboxForEvent(testEnv.DB, input.id);
		expect(outbox).toHaveLength(0);
	});

	it("sees a label inserted earlier in the same db.batch", async () => {
		const gateActionId = 8100;
		// Parent issuance_actions row is committed first; the issued_labels insert
		// itself rides in the same batch as the gated event + outbox, so the
		// EXISTS must observe an in-batch (uncommitted) sibling insert.
		await testEnv.DB.prepare(
			`INSERT INTO issuance_actions (id, actor, type, reason, idempotency_key, created_at)
			 VALUES (?, ?, 'manual-label', 'takedown', ?, '2026-07-13T00:00:00.000Z')`,
		)
			.bind(gateActionId, "did:web:labels.emdashcms.com", `batch-key-${gateActionId}`)
			.run();

		const input = eventInput({ gateOnIssuedLabelActionId: gateActionId });
		await testEnv.DB.batch([
			testEnv.DB.prepare(
				`INSERT INTO issued_labels (action_id, ver, src, uri, val, cts, sig, signing_key_id)
				 VALUES (?, 1, 'did:web:labels.emdashcms.com', 'did:plc:sub', '!takedown',
				         '2026-07-13T00:00:00.000Z', X'00', 'did:web:labels.emdashcms.com#atproto_label')`,
			).bind(gateActionId),
			buildOperationalEventInsert(testEnv.DB, input),
			buildOutboxInsert(testEnv.DB, {
				eventId: input.id,
				channel: "deployment-alert",
				now: input.now,
				gateOnIssuedLabelActionId: gateActionId,
			}),
		]);

		const eventCount = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM operational_events WHERE id = ?`,
		)
			.bind(input.id)
			.first<{ n: number }>();
		expect(eventCount?.n).toBe(1);
		expect(await getOutboxForEvent(testEnv.DB, input.id)).toHaveLength(1);
	});

	it("inserts neither row when the label is suppressed within the same db.batch", async () => {
		const gateActionId = 8200; // no issued_labels insert rides in the batch
		const input = eventInput({ gateOnIssuedLabelActionId: gateActionId });
		await testEnv.DB.batch([
			buildOperationalEventInsert(testEnv.DB, input),
			buildOutboxInsert(testEnv.DB, {
				eventId: input.id,
				channel: "deployment-alert",
				now: input.now,
				gateOnIssuedLabelActionId: gateActionId,
			}),
		]);

		const eventCount = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS n FROM operational_events WHERE id = ?`,
		)
			.bind(input.id)
			.first<{ n: number }>();
		expect(eventCount?.n).toBe(0);
		expect(await getOutboxForEvent(testEnv.DB, input.id)).toHaveLength(0);
	});
});

describe("dead_letters operational columns (0005)", () => {
	it("defaults status to 'new' with null resolution columns", async () => {
		await testEnv.DB.prepare(
			`INSERT INTO dead_letters (did, collection, rkey, reason, payload, received_at)
			 VALUES ('did:plc:x', 'com.example', 'r1', 'UNEXPECTED_ERROR', X'00', '2026-07-13T00:00:00.000Z')`,
		).run();

		const row = await testEnv.DB.prepare(
			`SELECT status, resolved_at, resolved_by_action_id FROM dead_letters
			 WHERE reason = 'UNEXPECTED_ERROR' AND rkey = 'r1'`,
		).first<{ status: string; resolved_at: string | null; resolved_by_action_id: string | null }>();
		expect(row).toEqual({ status: "new", resolved_at: null, resolved_by_action_id: null });
	});

	it("rejects an out-of-domain status", async () => {
		await expect(
			testEnv.DB.prepare(
				`INSERT INTO dead_letters (did, collection, rkey, reason, payload, received_at, status)
				 VALUES ('did:plc:x', 'com.example', 'r2', 'UNEXPECTED_ERROR', X'00', '2026-07-13T00:00:00.000Z', 'bogus')`,
			).run(),
		).rejects.toThrow();
	});
});
