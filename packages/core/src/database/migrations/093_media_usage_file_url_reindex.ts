import { type Kysely, type RawBuilder, sql } from "kysely";

import { isPostgres, tableExists } from "../dialect-helpers.js";

/**
 * Queues reconciliation for every actively tracked collection with rich text,
 * so its index picks up images and videos that name a local file by URL.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (
		!(await tableExists(db, "_emdash_media_usage_index_status")) ||
		!(await tableExists(db, "_emdash_media_usage_activation"))
	) {
		return;
	}

	await sql`
		UPDATE _emdash_media_usage_index_status
		SET change_epoch = change_epoch + 1,
			status = 'stale',
			completed_at = NULL,
			cursor = NULL,
			last_error_code = 'CONTENT_USAGE_STALE',
			reconciliation_required = 1,
			updated_at = ${sortableUtcTimestamp(db)}
		WHERE adapter_id = 'content-media'
			AND scope_type = 'collection'
			AND capture_state = 'active'
			AND EXISTS (
				SELECT 1
				FROM _emdash_collections AS collection
				WHERE collection.id = _emdash_media_usage_index_status.collection_id
					AND collection.slug = _emdash_media_usage_index_status.scope_key
			)
			AND EXISTS (
				SELECT 1
				FROM _emdash_fields AS field
				WHERE field.collection_id = _emdash_media_usage_index_status.collection_id
					AND field.type IN ('portableText', 'blocks')
			)
			AND EXISTS (
				SELECT 1
				FROM _emdash_media_usage_activation AS activation
				WHERE activation.task_key = 'incremental_capture'
					AND activation.state = 'active'
			)
	`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}

function sortableUtcTimestamp(db: Kysely<unknown>): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
	}
	return sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
}
