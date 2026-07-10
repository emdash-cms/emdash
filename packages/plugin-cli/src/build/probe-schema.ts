/**
 * Zod schema for the *probed* shape of a sandboxed plugin's compiled
 * default export.
 *
 * The pipeline imports `src/plugin.ts` after a probe build and reads the
 * default export to harvest the hook/route surface. The strict
 * `SandboxedPlugin` type in `@emdash-cms/plugin-types` rejects bad
 * shapes at compile time, but a plugin author can bypass typecheck
 * (untyped JS, dynamic config, `// @ts-ignore`) and ship a malformed
 * default export. This schema is the runtime contract the probe
 * enforces against that case.
 *
 * Scope choices:
 *
 * - The probe only cares about hook/route *keys* and *config*, not
 *   handler bodies. Handlers are validated as "is a function";
 *   signatures aren't checked here (TypeScript already did that for
 *   compliant authors, and the runtime will reject malformed calls).
 * - Per-entry configs use `looseObject` so plugins adding experimental
 *   fields don't break their own builds. The strict layer is the entry
 *   *shape*: a wrong-shaped entry produces a targeted error.
 * - Bare-function form (`"content:beforeSave": async (e, ctx) => {...}`)
 *   is normalised via `z.preprocess` into `{ handler: fn }` so the
 *   schema only has to validate one shape per entry.
 */

import { z } from "zod";

/** A function reference; the probe doesn't introspect signatures. */
const FunctionSchema = z.custom<(...args: unknown[]) => unknown>(
	(value) => typeof value === "function",
	{ message: "must be a function" },
);

/**
 * Map a probed hook/route entry into the canonical config form
 * (`{ handler }`) for the schema.
 *
 * - Functions become `{ handler: fn }`.
 * - Plain objects (prototype is `Object.prototype` or `null`) pass
 *   through; the schema validates their fields.
 * - Anything else (built-ins like `Date`, `RegExp`, `Promise`, `Map`,
 *   author-defined class instances, primitives) is reduced to `null`
 *   so the schema produces a single "expected object" issue at the
 *   entry root. Without this, the schema would reach into the wrong-
 *   shaped object for `handler` and report a misleading "missing
 *   handler" issue.
 */
function normaliseEntry(value: unknown): unknown {
	if (typeof value === "function") return { handler: value };
	if (value === null || typeof value !== "object") return value;
	const proto: unknown = Object.getPrototypeOf(value);
	if (proto === Object.prototype || proto === null) return value;
	return null;
}

/**
 * Finite-number check that produces a single clean message regardless
 * of how the input is invalid (wrong type, `NaN`, `Infinity`). Zod 4's
 * `z.number()` rejects `NaN`/`Infinity` with its own per-case messages
 * (`"expected number, received NaN"`) which read awkwardly to plugin
 * authors; this custom check folds all three failure modes into the
 * single "must be a finite number" line.
 */
const FiniteNumberSchema = z.custom<number>((v) => typeof v === "number" && Number.isFinite(v), {
	message: "must be a finite number",
});

const NonNegativeFiniteNumberSchema = z.custom<number>(
	(v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
	{ message: "must be a non-negative finite number" },
);

const HookEntryConfigSchema = z.looseObject({
	handler: FunctionSchema,
	priority: FiniteNumberSchema.optional(),
	timeout: NonNegativeFiniteNumberSchema.optional(),
	dependencies: z.array(z.string()).optional(),
	errorPolicy: z
		.enum(["continue", "abort"], {
			message: `must be "continue" or "abort"`,
		})
		.optional(),
	exclusive: z.boolean().optional(),
});

export const HookEntrySchema = z.preprocess(normaliseEntry, HookEntryConfigSchema);

const RouteEntryConfigSchema = z.looseObject({
	handler: FunctionSchema,
	public: z.boolean().optional(),
});

export const RouteEntrySchema = z.preprocess(normaliseEntry, RouteEntryConfigSchema);

/**
 * Coerce a non-record `hooks` / `routes` collection to an empty
 * object so it harvests no entries without failing the build. Plain
 * records pass through; `undefined` is preserved so the wrapped
 * `.optional()` accepts a missing collection.
 *
 * Returns `{}` rather than `undefined` so the wrapped `z.record` /
 * `.optional()` chain composes correctly under Zod 4 (an optional
 * record receiving `undefined` through `preprocess` errors with
 * "expected nonoptional, received undefined").
 */
function coerceOptionalRecord(value: unknown): unknown {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value;
}

/**
 * The probed module's default export shape. `hooks` and `routes` are
 * both optional — a plugin that declares only one of them is valid.
 * The top level is `looseObject` so additional keys on the default
 * export (e.g. metadata fields the runtime doesn't use) don't fail the
 * build; entries inside `hooks` / `routes` are validated strictly.
 */
export const ProbedDefaultSchema = z.looseObject({
	hooks: z.preprocess(coerceOptionalRecord, z.record(z.string(), HookEntrySchema)).optional(),
	routes: z.preprocess(coerceOptionalRecord, z.record(z.string(), RouteEntrySchema)).optional(),
});

export type ProbedDefault = z.infer<typeof ProbedDefaultSchema>;
export type ProbedHookEntry = z.infer<typeof HookEntrySchema>;
export type ProbedRouteEntry = z.infer<typeof RouteEntrySchema>;
