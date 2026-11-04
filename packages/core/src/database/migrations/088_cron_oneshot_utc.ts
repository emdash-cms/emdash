import { sql, type Kysely } from "kysely";

const BATCH_SIZE = 100;
const ISO_TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

export async function up(db: Kysely<unknown>): Promise<void> {
	let cursor = "";
	for (;;) {
		const rows = await sql<{ id: string; next_run_at: string }>`
			SELECT id, next_run_at
			FROM _emdash_cron_tasks
			WHERE is_oneshot = 1 AND id > ${cursor}
			ORDER BY id
			LIMIT ${BATCH_SIZE}
		`.execute(db);

		if (rows.rows.length === 0) break;
		for (const row of rows.rows) {
			const normalized = row.next_run_at.replace(" ", "T");
			const input = ISO_TIMEZONE_PATTERN.test(normalized) ? normalized : `${normalized}Z`;
			const parsed = new Date(input);
			if (Number.isNaN(parsed.getTime())) continue;
			const canonical = parsed.toISOString();
			if (canonical === row.next_run_at) continue;
			await sql`
				UPDATE _emdash_cron_tasks
				SET next_run_at = ${canonical}
				WHERE id = ${row.id} AND next_run_at = ${row.next_run_at}
			`.execute(db);
		}

		cursor = rows.rows.at(-1)!.id;
		if (rows.rows.length < BATCH_SIZE) break;
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// UTC normalization preserves the instant but not the original offset notation.
}
