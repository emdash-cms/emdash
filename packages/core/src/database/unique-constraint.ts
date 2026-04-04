/**
 * Detect duplicate-key / unique constraint failures across SQL drivers.
 * Used by insert-only paths (e.g. `putIfAbsent`) where conflict must map to `false`, not throw.
 */

function messageLooksLikeUniqueViolation(message: string): boolean {
	const m = message.toLowerCase();
	return (
		m.includes("unique constraint failed") ||
		m.includes("uniqueness violation") ||
		m.includes("duplicate key value violates unique constraint") ||
		m.includes("duplicate entry")
	);
}

function readPgCode(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	const o = err as Record<string, unknown>;
	const code = o.code;
	if (typeof code === "string" && code.length > 0) return code;
	const cause = o.cause;
	if (cause && typeof cause === "object") {
		const c = cause as Record<string, unknown>;
		if (typeof c.code === "string") return c.code;
	}
	return undefined;
}

/**
 * Returns true when `error` represents a primary/unique constraint violation on insert.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
	if (error == null) return false;

	const pg = readPgCode(error);
	if (pg === "23505") return true;

	let current: unknown = error;
	const seen = new Set<unknown>();
	for (let depth = 0; depth < 6 && current != null && !seen.has(current); depth++) {
		seen.add(current);
		if (current instanceof Error) {
			if (messageLooksLikeUniqueViolation(current.message)) return true;
			current = (current as Error & { cause?: unknown }).cause;
			continue;
		}
		if (typeof current === "object") {
			const o = current as Record<string, unknown>;
			const msg = o.message;
			if (typeof msg === "string" && messageLooksLikeUniqueViolation(msg)) return true;
			current = o.cause;
			continue;
		}
		break;
	}

	return false;
}
