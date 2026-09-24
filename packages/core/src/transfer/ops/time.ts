/**
 * Database-clock timestamps for transfer state. Every lease and expiry
 * comparison runs in SQL against the database clock, never a worker clock,
 * and every stored timestamp uses the sortable `YYYY-MM-DDTHH:MM:SS.sssZ`
 * form so plain string comparison orders them.
 */

import { sql, type Kysely, type RawBuilder } from "kysely";

import { isPostgres } from "../../database/dialect-helpers.js";
import type { Database } from "../../database/types.js";

type AnyKysely = Kysely<Database>;

export function timestampOffset(db: AnyKysely, seconds: number): RawBuilder<string> {
	if (!Number.isFinite(seconds)) throw new RangeError("Invalid timestamp offset");
	if (isPostgres(db)) {
		return sql<string>`to_char(
			clock_timestamp() AT TIME ZONE 'UTC' + (${seconds} * interval '1 second'),
			'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		)`;
	}
	return sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`${seconds >= 0 ? "+" : ""}${seconds} seconds`})`;
}

export function timestampNow(db: AnyKysely): RawBuilder<string> {
	return timestampOffset(db, 0);
}

/** `column <= now` */
export function timestampIsDue(db: AnyKysely, column: string): RawBuilder<boolean> {
	return isPostgres(db)
		? sql<boolean>`${sql.ref(column)}::timestamptz <= clock_timestamp()`
		: sql<boolean>`${sql.ref(column)} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

/** `column > now` */
export function timestampIsLive(db: AnyKysely, column: string): RawBuilder<boolean> {
	return isPostgres(db)
		? sql<boolean>`${sql.ref(column)}::timestamptz > clock_timestamp()`
		: sql<boolean>`${sql.ref(column)} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

/** `column <= now - seconds` */
export function timestampIsOlderThan(
	db: AnyKysely,
	column: string,
	seconds: number,
): RawBuilder<boolean> {
	if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("Invalid timestamp age");
	return isPostgres(db)
		? sql<boolean>`${sql.ref(column)}::timestamptz <= clock_timestamp() - (${seconds} * interval '1 second')`
		: sql<boolean>`${sql.ref(column)} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${seconds} seconds`})`;
}
