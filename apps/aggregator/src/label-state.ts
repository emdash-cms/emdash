import {
	isVerifiedListingLabel,
	parseListingLabel,
	type ListingLabelEvent,
	type VerifiedListingLabel,
} from "@emdash-cms/registry-moderation";

export function upsertVerifiedLabelState(
	db: D1Database,
	label: VerifiedListingLabel,
	trusted: boolean,
): Promise<unknown[]> {
	if (!isVerifiedListingLabel(label)) {
		throw new TypeError("label must be verified before persistence");
	}
	return upsertHydratedLabelState(db, label, trusted);
}

/** Persists labels loaded from an already authenticated local store. */
export function upsertHydratedLabelState(
	db: D1Database,
	label: ListingLabelEvent,
	trusted: boolean,
): Promise<unknown[]> {
	const parsed = parseListingLabel(label);
	const instant = persistedInstant(parsed.cts, "label.cts");
	const expEpoch = parsed.exp === undefined ? null : strictExpiryEpoch(parsed.exp);
	const digest = `hydrated:${JSON.stringify(parsed)}`;
	return db.batch([
		db
			.prepare(
				`INSERT INTO listing_label_state_expiry (src, uri, val, exp, exp_epoch)
				 SELECT ?, ?, ?, ?, ?
				 WHERE NOT EXISTS (
				   SELECT 1 FROM label_state current
				   WHERE current.src = ? AND current.uri = ? AND current.val = ?
				     AND current.cts_epoch IS NOT NULL
				     AND (current.cts_epoch > ? OR
				       (current.cts_epoch = ? AND current.cts_fraction > ?))
				 )
				 ON CONFLICT(src, uri, val) DO UPDATE SET
				   exp = excluded.exp,
				   exp_epoch = excluded.exp_epoch`,
			)
			.bind(
				parsed.src,
				parsed.uri,
				parsed.val,
				parsed.exp ?? null,
				expEpoch,
				parsed.src,
				parsed.uri,
				parsed.val,
				instant.epoch,
				instant.epoch,
				instant.fraction,
			),
		db
			.prepare(
				`INSERT INTO label_state
				   (src, uri, val, cid, neg, cts, exp, trusted, cts_epoch,
				    cts_fraction, digest, source_sequence, frame_index, collision)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
				 ON CONFLICT(src, uri, val) DO UPDATE SET
				   cid = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
				     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
				     OR label_state.cts_epoch IS NULL THEN excluded.cid ELSE label_state.cid END,
				   neg = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
				     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
				     OR label_state.cts_epoch IS NULL THEN excluded.neg ELSE label_state.neg END,
				   cts = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
				     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
				     OR label_state.cts_epoch IS NULL THEN excluded.cts ELSE label_state.cts END,
				   exp = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
				     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
				     OR label_state.cts_epoch IS NULL THEN excluded.exp ELSE label_state.exp END,
				   trusted = excluded.trusted,
				   cts_epoch = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
				     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
				     OR label_state.cts_epoch IS NULL THEN excluded.cts_epoch ELSE label_state.cts_epoch END,
				   cts_fraction = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
				     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
				     OR label_state.cts_epoch IS NULL THEN excluded.cts_fraction ELSE label_state.cts_fraction END,
				   digest = CASE WHEN excluded.cts_epoch > label_state.cts_epoch OR
				     (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
				     OR label_state.cts_epoch IS NULL THEN excluded.digest ELSE label_state.digest END,
				   collision = CASE
				     WHEN excluded.cts_epoch > label_state.cts_epoch OR
				       (excluded.cts_epoch = label_state.cts_epoch AND excluded.cts_fraction > label_state.cts_fraction)
				       OR label_state.cts_epoch IS NULL THEN 0
				     WHEN excluded.cts_epoch = label_state.cts_epoch
				       AND excluded.cts_fraction = label_state.cts_fraction
				       AND excluded.digest <> label_state.digest THEN 1
				     ELSE label_state.collision END
				 WHERE label_state.cts_epoch IS NULL
				    OR excluded.cts_epoch > label_state.cts_epoch
				    OR (excluded.cts_epoch = label_state.cts_epoch
				      AND excluded.cts_fraction > label_state.cts_fraction)
				    OR (excluded.cts_epoch = label_state.cts_epoch
				      AND excluded.cts_fraction = label_state.cts_fraction
				      AND excluded.digest <> label_state.digest)`,
			)
			.bind(
				parsed.src,
				parsed.uri,
				parsed.val,
				parsed.cid ?? null,
				parsed.neg === true ? 1 : 0,
				parsed.cts,
				parsed.exp ?? null,
				trusted ? 1 : 0,
				instant.epoch,
				instant.fraction,
				digest,
			),
	]);
}

function strictExpiryEpoch(exp: string): number {
	return persistedInstant(exp, "label.exp").epoch;
}

const STORED_FRACTION_DIGITS = 32;
const INSTANT_FRACTION =
	/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/;

export function persistedInstant(
	value: string,
	field: string,
): { epoch: number; fraction: string } {
	const match = INSTANT_FRACTION.exec(value);
	const milliseconds = Date.parse(value);
	if (!match || !Number.isFinite(milliseconds)) throw new TypeError(`${field} is invalid`);
	const fraction = match[1] ?? "";
	if (fraction.length > STORED_FRACTION_DIGITS) {
		throw new TypeError(`${field} has unsupported fractional precision`);
	}
	const epoch = Math.floor(milliseconds / 1000);
	if (!Number.isSafeInteger(epoch)) throw new TypeError(`${field} is outside the supported range`);
	return { epoch, fraction: fraction.padEnd(STORED_FRACTION_DIGITS, "0") };
}
