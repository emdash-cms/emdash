/**
 * Shared utility helpers used across multiple modules.
 */

/**
 * Type guard for narrowing `unknown` to `Record<string, unknown>` so
 * subsequent `value["key"]` accesses are typesafe without an `as` cast.
 * Excludes arrays (which are also `typeof === "object"`) so consumers
 * checking for "JSON-shaped object" get what they expect.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `globalThis.fetch` pre-bound. Pass this whenever a library wants a
 * `fetch` callable (resolver constructors, deps objects); the bare
 * global trips workerd's "Illegal invocation" check when called via a
 * stored reference.
 */
export const boundFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/**
 * Pull the verified record's CID out of a JSON-stringified
 * `signature_metadata` column value. Returns null on malformed input
 * (missing column, non-JSON, missing `cid` key) — callers decide what
 * to do; in writer-controlled data this never happens, but the
 * fallback keeps read-side comparisons robust against future schema
 * drift.
 */
export function parseSignatureMetadataCid(signatureMetadata: string | null): string | null {
	if (signatureMetadata === null) return null;
	try {
		const parsed: unknown = JSON.parse(signatureMetadata);
		if (isPlainObject(parsed) && typeof parsed["cid"] === "string") return parsed["cid"];
	} catch {
		// fall through
	}
	return null;
}
