import { describe, expect, it } from "vitest";

/**
 * The locale-aware list indexes (migration 041 / schema/registry.ts) are named
 * `idx_{table}_loc_upd` and `idx_{table}_loc_crt` where `table = ec_{slug}`.
 * Postgres truncates identifiers to 63 bytes, so the names must keep the
 * `upd`/`crt` discriminator inside the first 63 bytes for the longest slugs we
 * accept; otherwise both names truncate to the same identifier and the second
 * index either silently disappears (migration's `IF NOT EXISTS`) or hard-fails
 * collection creation (registry's plain `CREATE INDEX`).
 *
 * These names must stay identical between the two sources. The earlier
 * `deleted_locale_updated_id` / `deleted_locale_created_id` form collided from
 * slugs as short as 40 chars.
 */

function localeUpdatedIndexName(table: string): string {
	return `idx_${table}_loc_upd`;
}

function localeCreatedIndexName(table: string): string {
	return `idx_${table}_loc_crt`;
}

function truncateToPostgresIdentifier(name: string): string {
	return Buffer.from(name, "utf8").subarray(0, 63).toString("utf8");
}

describe("041 locale list index names", () => {
	it("stay <=63 bytes and distinct after Postgres truncation for a 47-char slug", () => {
		const table = `ec_${"a".repeat(47)}`;
		const updated = localeUpdatedIndexName(table);
		const created = localeCreatedIndexName(table);

		expect(Buffer.byteLength(updated, "utf8")).toBeLessThanOrEqual(63);
		expect(Buffer.byteLength(created, "utf8")).toBeLessThanOrEqual(63);
		expect(truncateToPostgresIdentifier(updated)).not.toBe(truncateToPostgresIdentifier(created));
	});

	it("stay distinct after truncation for every slug length up to 50 chars", () => {
		for (let slugLength = 1; slugLength <= 50; slugLength++) {
			const table = `ec_${"a".repeat(slugLength)}`;
			const updated = truncateToPostgresIdentifier(localeUpdatedIndexName(table));
			const created = truncateToPostgresIdentifier(localeCreatedIndexName(table));
			expect(updated, `slug length ${slugLength}`).not.toBe(created);
		}
	});
});
