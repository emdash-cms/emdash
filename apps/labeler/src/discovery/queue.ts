import { createD1AssessmentLifecycleStore } from "../assessment/lifecycle.js";
import { readAssessmentVersions } from "../runtime-config.js";
import { consumeDiscoveryItems, type DiscoveryQuarantineStore } from "./consumer.js";
import type { DiscoveryCursorStore } from "./cursor.js";
import { parseDiscoveryEvent, type DiscoveryStreamItem } from "./events.js";

const CURSOR_RE = /^[0-9]{1,32}$/;
const LEADING_ZERO_RE = /^0+/;

export async function processDiscoveryQueue(batch: MessageBatch, env: Env): Promise<void> {
	for (const message of batch.messages) {
		const item = parseQueueItem(message.body);
		if (!item) {
			await quarantineInvalidQueueEnvelope(env.DB, message.id, message.body);
			message.ack();
			continue;
		}
		try {
			const deliveryId = item.eventId ?? `legacy:${item.cursor}`;
			const orderKey = item.orderKey ?? deliveryId;
			const quarantineIdentity = identityForQueueItem(item);
			const hint = parseDiscoveryEvent(item.event);
			if (hint && (await isStaleSubjectDelivery(env.DB, hint.uri, item.cursor, orderKey))) {
				await markDeliveryProcessed(env.DB, deliveryId, item.cursor, new Date().toISOString());
				message.ack();
				continue;
			}
			await consumeDiscoveryItems([item], {
				workflow: env.ASSESSMENT_WORKFLOW,
				cursor: createDeliveryStore(env.DB, deliveryId, item.cursor),
				lifecycle: createD1AssessmentLifecycleStore(env.DB),
				quarantine: createD1DiscoveryQuarantineStore(env.DB, quarantineIdentity),
				versions: readAssessmentVersions(env),
			});
			if (hint) {
				await advanceSubjectCursor(
					env.DB,
					hint.uri,
					item.cursor,
					orderKey,
					new Date().toISOString(),
				);
			}
			message.ack();
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "discovery queue item failed",
					cursor: item.cursor,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			message.retry();
		}
	}
}

function createDeliveryStore(
	db: D1Database,
	deliveryId: string,
	deliveryCursor: string,
): DiscoveryCursorStore {
	return {
		async read() {
			const row = await db
				.prepare("SELECT cursor FROM discovery_deliveries WHERE delivery_id = ?")
				.bind(deliveryId)
				.first<{ cursor: string }>();
			return row?.cursor ?? null;
		},
		async advance(_expected, next, observedAt) {
			if (next !== deliveryCursor) return false;
			await db
				.prepare(
					`INSERT INTO discovery_deliveries (delivery_id, cursor, processed_at)
					 VALUES (?, ?, ?)
					 ON CONFLICT(delivery_id) DO NOTHING`,
				)
				.bind(deliveryId, next, observedAt)
				.run();
			return true;
		},
	};
}

export function createD1DiscoveryQuarantineStore(
	db: D1Database,
	identity: DiscoveryQuarantineIdentity,
): DiscoveryQuarantineStore {
	return {
		async write(entry) {
			await upsertDiscoveryQuarantine(db, {
				...identity,
				cursor: entry.cursor,
				reason: entry.reason,
				eventSummary: entry.eventSummary,
				eventJson: null,
				observedAt: entry.observedAt,
				replaceSummary: true,
			});
		},
	};
}

export async function quarantineDiscoveryDeadLetters(batch: MessageBatch, env: Env): Promise<void> {
	for (const message of batch.messages) {
		const item = parseQueueItem(message.body);
		if (!item) {
			await quarantineInvalidQueueEnvelope(env.DB, message.id, message.body);
			message.ack();
			continue;
		}
		const eventJson = JSON.stringify(item.event);
		await upsertDiscoveryQuarantine(env.DB, {
			...identityForQueueItem(item),
			cursor: item.cursor,
			reason: "queue-retries-exhausted",
			eventSummary: JSON.stringify({ kind: "queue-retries-exhausted" }),
			eventJson: new TextEncoder().encode(eventJson).byteLength <= 256 * 1024 ? eventJson : null,
			observedAt: new Date().toISOString(),
			replaceSummary: false,
		});
		message.ack();
	}
}

async function quarantineInvalidQueueEnvelope(
	db: D1Database,
	messageId: string,
	body: unknown,
): Promise<void> {
	let eventJson: string | null = null;
	try {
		const serialized = JSON.stringify(body);
		if (new TextEncoder().encode(serialized).byteLength <= 256 * 1024) eventJson = serialized;
	} catch {
		eventJson = null;
	}
	const quarantineId = `invalid:${messageId}`;
	await upsertDiscoveryQuarantine(db, {
		quarantineId,
		eventId: null,
		orderKey: quarantineId,
		cursor: quarantineId,
		reason: "invalid-queue-envelope",
		eventSummary: JSON.stringify({ kind: "invalid-queue-envelope" }),
		eventJson,
		observedAt: new Date().toISOString(),
		replaceSummary: true,
	});
}

interface DiscoveryQuarantineIdentity {
	quarantineId: string;
	eventId: string | null;
	orderKey: string;
}

interface DiscoveryQuarantineWrite extends DiscoveryQuarantineIdentity {
	cursor: string;
	reason: string;
	eventSummary: string;
	eventJson: string | null;
	observedAt: string;
	replaceSummary: boolean;
}

function identityForQueueItem(item: DiscoveryStreamItem): DiscoveryQuarantineIdentity {
	if (item.eventId) {
		const orderKey = item.orderKey ?? item.eventId;
		return {
			quarantineId: `event:${item.cursor}:${item.eventId.length}:${item.eventId}:${orderKey}`,
			eventId: item.eventId,
			orderKey,
		};
	}
	if (item.orderKey) {
		return {
			quarantineId: `order:${item.cursor}:${item.orderKey}`,
			eventId: null,
			orderKey: item.orderKey,
		};
	}
	return {
		quarantineId: `legacy:${item.cursor}`,
		eventId: null,
		orderKey: `legacy:${item.cursor}`,
	};
}

async function upsertDiscoveryQuarantine(
	db: D1Database,
	entry: DiscoveryQuarantineWrite,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO discovery_quarantine_events
			   (quarantine_id, cursor, event_id, order_key, reason, event_summary,
			    requires_reconciliation, event_json, observed_at, revision)
			 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1)
			 ON CONFLICT(quarantine_id) DO UPDATE SET
			   cursor = excluded.cursor,
			   event_id = excluded.event_id,
			   order_key = excluded.order_key,
			   reason = excluded.reason,
			   event_summary = CASE WHEN ? = 1
			     THEN excluded.event_summary
			     ELSE discovery_quarantine_events.event_summary
			   END,
			   requires_reconciliation = 1,
			   event_json = COALESCE(excluded.event_json, discovery_quarantine_events.event_json),
			   observed_at = excluded.observed_at,
			   revision = discovery_quarantine_events.revision + 1`,
		)
		.bind(
			entry.quarantineId,
			entry.cursor,
			entry.eventId,
			entry.orderKey,
			entry.reason,
			entry.eventSummary,
			entry.eventJson,
			entry.observedAt,
			entry.replaceSummary ? 1 : 0,
		)
		.run();
}

async function isStaleSubjectDelivery(
	db: D1Database,
	uri: string,
	cursor: string,
	orderKey: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT cursor, order_key FROM discovery_subject_cursors WHERE uri = ?")
		.bind(uri)
		.first<{ cursor: string; order_key: string }>();
	if (!row) return false;
	const cursorOrder = compareCursor(row.cursor, cursor);
	return cursorOrder > 0 || (cursorOrder === 0 && row.order_key >= orderKey);
}

async function advanceSubjectCursor(
	db: D1Database,
	uri: string,
	cursor: string,
	orderKey: string,
	updatedAt: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO discovery_subject_cursors (uri, cursor, order_key, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(uri) DO UPDATE SET
			   cursor = excluded.cursor,
			   order_key = excluded.order_key,
			   updated_at = excluded.updated_at
			 WHERE length(excluded.cursor) > length(discovery_subject_cursors.cursor)
			    OR (length(excluded.cursor) = length(discovery_subject_cursors.cursor)
			        AND excluded.cursor > discovery_subject_cursors.cursor)
			    OR (excluded.cursor = discovery_subject_cursors.cursor
			        AND excluded.order_key > discovery_subject_cursors.order_key)`,
		)
		.bind(uri, cursor, orderKey, updatedAt)
		.run();
}

async function markDeliveryProcessed(
	db: D1Database,
	deliveryId: string,
	cursor: string,
	processedAt: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO discovery_deliveries (delivery_id, cursor, processed_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(delivery_id) DO NOTHING`,
		)
		.bind(deliveryId, cursor, processedAt)
		.run();
}

function compareCursor(left: string, right: string): number {
	const normalizedLeft = left.replace(LEADING_ZERO_RE, "") || "0";
	const normalizedRight = right.replace(LEADING_ZERO_RE, "") || "0";
	if (normalizedLeft.length !== normalizedRight.length) {
		return normalizedLeft.length < normalizedRight.length ? -1 : 1;
	}
	return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function parseQueueItem(value: unknown): DiscoveryStreamItem | null {
	if (
		typeof value !== "object" ||
		value === null ||
		!("cursor" in value) ||
		!("event" in value) ||
		typeof value.cursor !== "string" ||
		!CURSOR_RE.test(value.cursor)
	) {
		return null;
	}
	const eventId = "eventId" in value ? value.eventId : undefined;
	if (eventId !== undefined && (typeof eventId !== "string" || eventId.length > 128)) return null;
	const orderKey = "orderKey" in value ? value.orderKey : undefined;
	if (orderKey !== undefined && (typeof orderKey !== "string" || orderKey.length > 256))
		return null;
	return {
		cursor: value.cursor,
		...(eventId ? { eventId } : {}),
		...(orderKey ? { orderKey } : {}),
		event: value.event,
	};
}
