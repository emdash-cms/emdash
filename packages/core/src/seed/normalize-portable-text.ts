/**
 * Portable Text key normalization for seed data.
 *
 * Background: the Portable Text spec (https://github.com/portabletext/portabletext)
 * requires every block, span, and mark definition to carry a stable
 * `_key`. EmDash's `portableText` field schema enforces this -- the
 * generated Zod validator includes `_key: z.string()` on every block.
 *
 * Seed files written by humans (and by some converters) often omit
 * `_key` because it's a UI / editor concern. Without a normalization
 * pass, those keyless blocks land in the database verbatim, then
 * fail the same validator on the very first autosave the admin UI
 * issues for the entry -- effectively making content from keyless
 * seeds unsavable. (Issue #867.)
 *
 * This helper walks any data shape and injects a `_key` on every
 * object that carries a `_type` field (the canonical PT marker) when
 * one is missing. It is:
 *
 *   - **Idempotent.** Existing `_key` values are preserved untouched.
 *   - **Schema-agnostic.** It does not need to know which fields are
 *     `portableText`. It walks the whole `data` object so custom block
 *     types contributed by plugins, nested arrays in component widgets,
 *     and any other PT-shaped payload gets normalized in one place.
 *   - **Counter-based.** Keys are deterministic for a given input
 *     traversal order (`k0`, `k1`, ...). Determinism keeps seed reruns
 *     idempotent and makes the values diff-friendly in tests.
 *
 * The normalizer is only applied to seed ingestion. The REST/MCP write
 * paths intentionally keep strict validation: real client errors should
 * surface, not be silently patched.
 */

interface Ctx {
	counter: number;
	/**
	 * Existing `_key` values seen anywhere in the input. Generated keys
	 * skip any value already in this set to avoid colliding with an
	 * explicit key the seed author put on a sibling block. PT keys
	 * only need to be unique within one document, but PT-aware tooling
	 * (the editor, revision diffing) treats duplicate keys as a bug.
	 */
	taken: Set<string>;
}

/**
 * Recursively walk `value` and inject `_key` on every object that
 * carries a `_type` but lacks `_key`. Returns a new value -- the input
 * is not mutated.
 *
 * Overloads keep static types accurate at the two seed call sites
 * without resorting to a generic `<T>(value: T): T` -- which the
 * stricter lint rules forbid because the function does in fact add
 * new fields the input type may not declare. PT-shaped data is
 * `unknown`-typed at the type level anyway (see `SeedSection.content`
 * and `SeedWidget.content` in `./types.ts`), so the structural
 * overloads we provide cover every real caller.
 */
export function normalizePortableTextKeys(value: Record<string, unknown>): Record<string, unknown>;
export function normalizePortableTextKeys(value: unknown[]): unknown[];
export function normalizePortableTextKeys(value: unknown): unknown;
export function normalizePortableTextKeys(value: unknown): unknown {
	const ctx: Ctx = { counter: 0, taken: new Set() };
	collectExistingKeys(value, ctx.taken);
	return walk(value, ctx);
}

/**
 * First pass: harvest every existing `_key` so the generation pass
 * doesn't mint a value that collides with one. Walking twice is
 * negligible compared to the JSON.stringify that follows for the DB
 * write, and keeps the generation pass simple.
 */
function collectExistingKeys(value: unknown, taken: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectExistingKeys(item, taken);
		return;
	}
	if (value !== null && typeof value === "object") {
		// Indexing an `object` directly is type-safe under TS's
		// `Record<PropertyKey, unknown>` interpretation; no cast needed.
		const maybeKey = (value as { _key?: unknown })._key;
		if (typeof maybeKey === "string" && maybeKey.length > 0) {
			taken.add(maybeKey);
		}
		for (const v of Object.values(value)) collectExistingKeys(v, taken);
	}
}

function walk(value: unknown, ctx: Ctx): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => walk(item, ctx));
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			result[k] = walk(v, ctx);
		}
		// Inject _key only when this object looks like a PT node
		// (has a string _type) and doesn't already carry one. We check
		// for an existing non-empty string so a literal `_key: ""`
		// from buggy upstream data still gets replaced -- the validator
		// rejects empty strings just as it rejects `undefined`.
		//
		// We inject deeper than `zod-generator.ts` strictly requires --
		// it only validates `_key` on top-level blocks (`.passthrough()`
		// allows missing keys on spans, markDefs, and custom inline
		// nodes). Going deeper matches what the admin editor and the
		// gutenberg converter already produce, and is what Sanity's
		// PT toolchain expects, so we normalize uniformly.
		if (typeof result._type === "string") {
			if (typeof result._key !== "string" || result._key.length === 0) {
				result._key = nextKey(ctx);
			}
		}
		return result;
	}
	return value;
}

function nextKey(ctx: Ctx): string {
	// Skip keys that already exist anywhere in the document so we don't
	// produce duplicates when only some blocks carry an explicit key.
	for (;;) {
		const key = `k${ctx.counter.toString(36)}`;
		ctx.counter += 1;
		if (!ctx.taken.has(key)) {
			ctx.taken.add(key);
			return key;
		}
	}
}
