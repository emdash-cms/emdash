/**
 * Shared detection helpers for database-layer error messages.
 *
 * Different SQL dialects phrase "table or relation does not exist" differently:
 *
 * - SQLite / D1:    "no such table: foo"
 * - PostgreSQL:     'relation "foo" does not exist'
 *                   'table "foo" does not exist'
 * - MySQL (future): "Table 'db.foo' doesn't exist"
 *
 * Runtime code paths that short-circuit on missing tables (pre-migration
 * probes, optional feature tables, etc.) should use these helpers rather
 * than hand-rolling string matches per call-site.
 */

/**
 * Extract a lowercase error message from any unknown value, safely.
 */
function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message.toLowerCase();
	if (typeof error === "string") return error.toLowerCase();
	return "";
}

/**
 * Returns true when `error` is a "table does not exist" error across the
 * dialects EmDash supports (D1/SQLite and PostgreSQL). Used by runtime
 * probes to treat pre-migration databases as empty without logging a scary
 * warning, while still propagating unrelated errors (permissions, connection
 * loss, syntax issues) to callers.
 */
export function isMissingTableError(error: unknown): boolean {
	const message = messageOf(error);
	if (!message) return false;

	// SQLite / D1
	if (message.includes("no such table")) return true;

	// PostgreSQL (and some MySQL variants): "relation ... does not exist" /
	// "table ... does not exist" / "doesn't exist".
	if (message.includes("does not exist") || message.includes("doesn't exist")) {
		return message.includes("relation") || message.includes("table");
	}

	return false;
}
