import { ulid } from "ulidx";

/**
 * The operational-alert vocabulary, grown by W9.6. Validated in app code (the
 * mutation handlers are the only writers), so the `operational_events.event_type`
 * column carries no SQL CHECK and each workstream stays purely additive.
 */
export type OperationalEventType =
	| "emergency-takedown"
	| "publisher-compromised"
	| "automation-paused"
	| "automation-resumed"
	| "dead-letter-retried"
	| "dead-letter-quarantined"
	| "reconsideration-opened"
	| "reconsideration-resolved"
	| "assessment-prolonged-error"
	| "takedown-no-contact";

export type OperationalEventSeverity = "critical" | "high" | "info";

/**
 * The alert deliverable's public-safe body (spec §18.2): subject URI and label
 * value live in dedicated columns; this carries the operator reason only. It has
 * no field for findings, private detail, or evidence refs — the type is the
 * enforcement, so an event can never smuggle exploit detail into an outbound
 * notification.
 */
export interface OperationalEventPayload {
	reason?: string;
	/** The escalated run and its release CID for `assessment-prolonged-error`.
	 * Both are public identifiers (the assessment id the public API returns, the
	 * record's content hash) — no findings or private detail. */
	assessmentId?: string;
	cid?: string;
}

export interface OperationalEventInsert {
	id: string;
	eventType: OperationalEventType;
	severity: OperationalEventSeverity;
	actionId?: string | null;
	subjectUri?: string | null;
	labelValue?: string | null;
	payload: OperationalEventPayload;
	now: Date;
	/**
	 * When set, the INSERT becomes an `INSERT ... SELECT ... WHERE EXISTS` gated
	 * on an `issued_labels` row carrying this `action_id`. Batched after the
	 * label's issuance statements, the EXISTS sees the just-inserted label; if
	 * that label was suppressed in-batch (a signing-state race), the event does
	 * not insert either — so no alert fires for a label that never landed.
	 */
	gateOnIssuedLabelActionId?: number;
	/**
	 * The same in-batch label gate keyed on the issuance action's idempotency
	 * key rather than the numeric `issuance_actions.id`. The real issuance path
	 * (`prepareManualLabelIssuance`) lets D1 autoincrement `issuance_actions.id`,
	 * so the numeric id is unknown before the batch commits — but the idempotency
	 * key is the caller-minted operator action id. The gate joins through
	 * `issuance_actions` to reach the label, so a signing-suppressed batch (no
	 * `issued_labels` row) inserts neither the event nor its outbox row.
	 */
	gateOnIssuedLabelActionKey?: string;
	/**
	 * Gates the event on this reconsideration having been resolved by this action:
	 * `EXISTS (SELECT 1 FROM reconsiderations WHERE id = ? AND outcome_action_id = ?)`.
	 * Batched after the resolve UPDATE (which guards on `state = 'open'`), so a
	 * losing concurrent resolve — whose UPDATE matched zero rows — inserts no
	 * phantom resolved-event while its audit row still commits for replay.
	 */
	gateOnResolvedReconsideration?: { reconsiderationId: string; actionId: string };
	/**
	 * When set, the INSERT is gated on the `assessment_error_escalations` row for
	 * this assessment still being un-alerted. Batched atomically with the
	 * `operator_alerted_at` mark, it makes the prolonged-error operator alert
	 * at-most-once even under overlapping cron ticks: a second pass that read the
	 * row unalerted before the first committed still inserts no event, because its
	 * EXISTS sees the committed mark (the app-level null read alone cannot — cron
	 * ticks are not serialized against each other).
	 */
	gateOnUnalertedEscalation?: { assessmentId: string };
	/**
	 * Appends `ON CONFLICT ... DO NOTHING` targeting the partial unique index on
	 * `(action_id, event_type) WHERE event_type = 'takedown-no-contact'` (migration
	 * 0012), so a concurrent replay of the `takedown-no-contact` alert converges to
	 * one row. Only valid for that event type with a non-null `actionId` and no
	 * gate. Pair the outbox with {@link OutboxInsert.gateOnEventPresent} so a
	 * conflicted (no-op) event does not orphan an outbox row.
	 */
	idempotentTakedownNoContact?: boolean;
}

export interface OutboxInsert {
	eventId: string;
	channel: string;
	now: Date;
	/** Same in-batch label gating as {@link OperationalEventInsert}. */
	gateOnIssuedLabelActionId?: number;
	/** Same in-batch label gating as {@link OperationalEventInsert.gateOnIssuedLabelActionKey}. */
	gateOnIssuedLabelActionKey?: string;
	/** Insert only if the event row was actually written — `WHERE EXISTS (event
	 * with this id)`. Pairs with {@link OperationalEventInsert.idempotentTakedownNoContact}
	 * so an ON CONFLICT no-op event leaves no orphan outbox row in the same batch. */
	gateOnEventPresent?: boolean;
}

export interface StoredOperationalEvent {
	id: string;
	eventType: string;
	severity: string;
	actionId: string | null;
	subjectUri: string | null;
	labelValue: string | null;
	payloadJson: string;
	createdAt: string;
	createdAtEpochMs: number;
}

export interface StoredOutboxEntry {
	id: string;
	eventId: string;
	channel: string;
	state: string;
	attempts: number;
	lastError: string | null;
	createdAt: string;
	createdAtEpochMs: number;
	sentAt: string | null;
}

interface OperationalEventRow {
	id: string;
	event_type: string;
	severity: string;
	action_id: string | null;
	subject_uri: string | null;
	label_value: string | null;
	payload_json: string;
	created_at: string;
	created_at_epoch_ms: number;
}

interface OutboxRow {
	id: string;
	event_id: string;
	channel: string;
	state: string;
	attempts: number;
	last_error: string | null;
	created_at: string;
	created_at_epoch_ms: number;
	sent_at: string | null;
}

export function newOperationalEventId(): string {
	return `oev_${ulid()}`;
}

export function newNotificationOutboxId(): string {
	return `nob_${ulid()}`;
}

/**
 * Insert for one operational event. Batched with the operator_actions row + the
 * effect statements by `commitMutation`; never run alone for an issuance event.
 * When `gateOnIssuedLabelActionId` is set the insert is gated on the label's
 * in-batch existence (see {@link OperationalEventInsert}); otherwise it is a
 * plain INSERT for events with no issued label (pause/resume, DLQ controls).
 */
export function buildOperationalEventInsert(
	db: D1Database,
	input: OperationalEventInsert,
): D1PreparedStatement {
	const columns = `id, event_type, severity, action_id, subject_uri, label_value,
		 payload_json, created_at, created_at_epoch_ms`;
	const values: (string | number | null)[] = [
		input.id,
		input.eventType,
		input.severity,
		input.actionId ?? null,
		input.subjectUri ?? null,
		input.labelValue ?? null,
		JSON.stringify(input.payload),
		input.now.toISOString(),
		input.now.getTime(),
	];

	if (input.gateOnIssuedLabelActionKey !== undefined) {
		return db
			.prepare(
				`INSERT INTO operational_events (${columns})
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (
					SELECT 1 FROM issued_labels l
					JOIN issuance_actions a ON a.id = l.action_id
					WHERE a.idempotency_key = ?
				 )`,
			)
			.bind(...values, input.gateOnIssuedLabelActionKey);
	}

	if (input.gateOnResolvedReconsideration !== undefined) {
		return db
			.prepare(
				`INSERT INTO operational_events (${columns})
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (
					SELECT 1 FROM reconsiderations WHERE id = ? AND outcome_action_id = ?
				 )`,
			)
			.bind(
				...values,
				input.gateOnResolvedReconsideration.reconsiderationId,
				input.gateOnResolvedReconsideration.actionId,
			);
	}

	if (input.gateOnIssuedLabelActionId !== undefined) {
		return db
			.prepare(
				`INSERT INTO operational_events (${columns})
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (SELECT 1 FROM issued_labels WHERE action_id = ?)`,
			)
			.bind(...values, input.gateOnIssuedLabelActionId);
	}

	if (input.gateOnUnalertedEscalation !== undefined) {
		return db
			.prepare(
				`INSERT INTO operational_events (${columns})
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (
					SELECT 1 FROM assessment_error_escalations
					WHERE assessment_id = ? AND operator_alerted_at_epoch_ms IS NULL
				 )`,
			)
			.bind(...values, input.gateOnUnalertedEscalation.assessmentId);
	}

	// The conflict target repeats the partial index's predicate so SQLite resolves
	// it to `idx_operational_events_takedown_no_contact` (migration 0012).
	const onConflict = input.idempotentTakedownNoContact
		? ` ON CONFLICT (action_id, event_type) WHERE event_type = 'takedown-no-contact' DO NOTHING`
		: "";
	return db
		.prepare(
			`INSERT INTO operational_events (${columns})
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)${onConflict}`,
		)
		.bind(...values);
}

/**
 * Insert for one delivery-queue row (one per event + channel). Gated identically
 * to {@link buildOperationalEventInsert}: a signing-suppressed batch queues no
 * notification. `state` and `attempts` fall to their column defaults.
 */
export function buildOutboxInsert(db: D1Database, input: OutboxInsert): D1PreparedStatement {
	const values: (string | number)[] = [
		newNotificationOutboxId(),
		input.eventId,
		input.channel,
		input.now.toISOString(),
		input.now.getTime(),
	];

	if (input.gateOnIssuedLabelActionKey !== undefined) {
		return db
			.prepare(
				`INSERT INTO notification_outbox (id, event_id, channel, created_at, created_at_epoch_ms)
				 SELECT ?, ?, ?, ?, ?
				 WHERE EXISTS (
					SELECT 1 FROM issued_labels l
					JOIN issuance_actions a ON a.id = l.action_id
					WHERE a.idempotency_key = ?
				 )`,
			)
			.bind(...values, input.gateOnIssuedLabelActionKey);
	}

	if (input.gateOnIssuedLabelActionId !== undefined) {
		return db
			.prepare(
				`INSERT INTO notification_outbox (id, event_id, channel, created_at, created_at_epoch_ms)
				 SELECT ?, ?, ?, ?, ?
				 WHERE EXISTS (SELECT 1 FROM issued_labels WHERE action_id = ?)`,
			)
			.bind(...values, input.gateOnIssuedLabelActionId);
	}

	if (input.gateOnEventPresent) {
		return db
			.prepare(
				`INSERT INTO notification_outbox (id, event_id, channel, created_at, created_at_epoch_ms)
				 SELECT ?, ?, ?, ?, ?
				 WHERE EXISTS (SELECT 1 FROM operational_events WHERE id = ?)`,
			)
			.bind(...values, input.eventId);
	}

	return db
		.prepare(
			`INSERT INTO notification_outbox (id, event_id, channel, created_at, created_at_epoch_ms)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(...values);
}

/** Operational-event page, newest first over `idx_operational_events_created`. */
export async function getOperationalEvents(
	db: D1Database,
	options: { limit: number },
): Promise<StoredOperationalEvent[]> {
	const rows = await db
		.prepare(
			`SELECT id, event_type, severity, action_id, subject_uri, label_value,
			 payload_json, created_at, created_at_epoch_ms
			 FROM operational_events
			 ORDER BY created_at_epoch_ms DESC, id DESC
			 LIMIT ?`,
		)
		.bind(options.limit)
		.all<OperationalEventRow>();
	return (rows.results ?? []).map(rowToStoredEvent);
}

/** Events emitted by a single operator action, newest first. */
export async function getOperationalEventsByActionId(
	db: D1Database,
	actionId: string,
): Promise<StoredOperationalEvent[]> {
	const rows = await db
		.prepare(
			`SELECT id, event_type, severity, action_id, subject_uri, label_value,
			 payload_json, created_at, created_at_epoch_ms
			 FROM operational_events
			 WHERE action_id = ?
			 ORDER BY created_at_epoch_ms DESC, id DESC`,
		)
		.bind(actionId)
		.all<OperationalEventRow>();
	return (rows.results ?? []).map(rowToStoredEvent);
}

/** Outbox rows for one event, oldest first. */
export async function getOutboxForEvent(
	db: D1Database,
	eventId: string,
): Promise<StoredOutboxEntry[]> {
	const rows = await db
		.prepare(
			`SELECT id, event_id, channel, state, attempts, last_error,
			 created_at, created_at_epoch_ms, sent_at
			 FROM notification_outbox
			 WHERE event_id = ?
			 ORDER BY created_at_epoch_ms ASC, id ASC`,
		)
		.bind(eventId)
		.all<OutboxRow>();
	return (rows.results ?? []).map(rowToStoredOutbox);
}

function rowToStoredEvent(row: OperationalEventRow): StoredOperationalEvent {
	return {
		id: row.id,
		eventType: row.event_type,
		severity: row.severity,
		actionId: row.action_id,
		subjectUri: row.subject_uri,
		labelValue: row.label_value,
		payloadJson: row.payload_json,
		createdAt: row.created_at,
		createdAtEpochMs: row.created_at_epoch_ms,
	};
}

function rowToStoredOutbox(row: OutboxRow): StoredOutboxEntry {
	return {
		id: row.id,
		eventId: row.event_id,
		channel: row.channel,
		state: row.state,
		attempts: row.attempts,
		lastError: row.last_error,
		createdAt: row.created_at,
		createdAtEpochMs: row.created_at_epoch_ms,
		sentAt: row.sent_at,
	};
}
