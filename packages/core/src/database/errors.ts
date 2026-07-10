/**
 * Database error types. Kept in their own module (no driver imports) so the
 * public package barrel can re-export them without dragging native database
 * drivers into the module graph of consumers that picked a different dialect.
 */
export class EmDashDatabaseError extends Error {
	constructor(
		message: string,
		public override cause?: unknown,
	) {
		super(message);
		this.name = "EmDashDatabaseError";
	}
}
