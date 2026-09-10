export interface DiscoveryCursorStore {
	read(): Promise<string | null>;
	advance(expected: string | null, next: string, observedAt: string): Promise<boolean>;
}

export function createD1DiscoveryCursorStore(
	db: D1Database,
	stream = "registry-records",
): DiscoveryCursorStore {
	return {
		async read() {
			const row = await db
				.prepare(`SELECT cursor FROM ingest_state WHERE stream = ?`)
				.bind(stream)
				.first<{ cursor: string | null }>();
			return row?.cursor ?? null;
		},
		async advance(expected, next, observedAt) {
			if (expected === null) {
				const result = await db
					.prepare(
						`INSERT INTO ingest_state (stream, cursor, last_observed_at, updated_at)
						 VALUES (?, ?, ?, ?)
						 ON CONFLICT(stream) DO NOTHING`,
					)
					.bind(stream, next, observedAt, observedAt)
					.run();
				return result.meta.changes === 1;
			}
			const result = await db
				.prepare(
					`UPDATE ingest_state SET cursor = ?, last_observed_at = ?, updated_at = ?
					 WHERE stream = ? AND cursor = ?`,
				)
				.bind(next, observedAt, observedAt, stream, expected)
				.run();
			return result.meta.changes === 1;
		},
	};
}
