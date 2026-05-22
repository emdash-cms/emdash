/**
 * Tests for `parseProbedDefault`, the runtime validation the build
 * pipeline runs against the imported default export of a probed plugin.
 *
 * These tests lock in the user-facing error-message contract: plugin
 * authors and any aggregator that scrapes stderr depend on these
 * exact strings. Behaviour changes here should be deliberate.
 */

import { describe, expect, it } from "vitest";

import { BuildPipelineError, parseProbedDefault } from "../src/build/pipeline.js";

const PLUGIN_ENTRY = "src/plugin.ts";

function expectFailure(input: Record<string, unknown>): BuildPipelineError {
	try {
		parseProbedDefault(PLUGIN_ENTRY, input);
	} catch (error) {
		if (error instanceof BuildPipelineError) return error;
		throw error;
	}
	throw new Error("Expected parseProbedDefault to throw, but it succeeded");
}

describe("parseProbedDefault", () => {
	describe("valid shapes", () => {
		it("accepts the empty default export", () => {
			const result = parseProbedDefault(PLUGIN_ENTRY, {});
			expect(result.hooks).toBeUndefined();
			expect(result.routes).toBeUndefined();
		});

		it("normalises bare-function hooks to the config form", () => {
			const handler = (): void => {};
			const result = parseProbedDefault(PLUGIN_ENTRY, {
				hooks: { "content:beforeSave": handler },
			});
			expect(result.hooks?.["content:beforeSave"]).toEqual({ handler });
		});

		it("preserves config-form hook fields", () => {
			const handler = (): void => {};
			const result = parseProbedDefault(PLUGIN_ENTRY, {
				hooks: {
					"content:beforeSave": {
						handler,
						priority: 50,
						timeout: 1000,
						dependencies: ["other-plugin"],
						errorPolicy: "continue",
						exclusive: true,
					},
				},
			});
			expect(result.hooks?.["content:beforeSave"]).toEqual({
				handler,
				priority: 50,
				timeout: 1000,
				dependencies: ["other-plugin"],
				errorPolicy: "continue",
				exclusive: true,
			});
		});

		it("normalises bare-function routes to the config form", () => {
			const handler = (): void => {};
			const result = parseProbedDefault(PLUGIN_ENTRY, {
				routes: { ping: handler },
			});
			expect(result.routes?.ping).toEqual({ handler });
		});

		it("preserves config-form route fields including public", () => {
			const handler = (): void => {};
			const result = parseProbedDefault(PLUGIN_ENTRY, {
				routes: { ping: { handler, public: true } },
			});
			expect(result.routes?.ping).toEqual({ handler, public: true });
		});

		it("passes through unknown extra keys on the default export", () => {
			const handler = (): void => {};
			const result = parseProbedDefault(PLUGIN_ENTRY, {
				hooks: { h: { handler, experimentalKnob: "future" } },
				somethingElse: 42,
			});
			expect(result.hooks?.h).toMatchObject({ handler, experimentalKnob: "future" });
		});
	});

	describe("hook validation errors", () => {
		it("rejects a non-function/non-object hook entry", () => {
			const error = expectFailure({ hooks: { h: "not a function" } });
			expect(error.code).toBe("INVALID_PLUGIN_FORMAT");
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" must be a function or { handler: function, ... }. Got string.`,
			);
		});

		it("rejects a Date hook entry as the wrong shape", () => {
			// Only plain objects (`Object.prototype` or null prototype)
			// reach the per-field validation. Anything with a more
			// specific prototype is treated as a wrong-shaped entry.
			const error = expectFailure({ hooks: { h: new Date() } });
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" must be a function or { handler: function, ... }. Got object.`,
			);
		});

		it("rejects a RegExp hook entry as the wrong shape", () => {
			const error = expectFailure({ hooks: { h: /x/ } });
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" must be a function or { handler: function, ... }. Got object.`,
			);
		});

		it("rejects a Promise hook entry as the wrong shape", () => {
			// Forgot-to-await mistake: `hooks: { h: makeHandler() }` where
			// `makeHandler` is async. Caught at the entry-shape level so
			// the author sees the standard wrong-shape message.
			const error = expectFailure({ hooks: { h: Promise.resolve(() => {}) } });
			expect(error.code).toBe("INVALID_PLUGIN_FORMAT");
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" must be a function or { handler: function, ... }. Got object.`,
			);
		});

		it("rejects a hook entry missing its handler", () => {
			const error = expectFailure({ hooks: { h: { errorPolicy: "abort" } } });
			expect(error.code).toBe("INVALID_PLUGIN_FORMAT");
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" has invalid handler undefined (must be a function).`,
			);
		});

		it("rejects an invalid errorPolicy", () => {
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, errorPolicy: "bogus" } },
			});
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" has invalid errorPolicy "bogus" (must be "continue" or "abort").`,
			);
		});

		it("rejects a non-number priority", () => {
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, priority: "high" } },
			});
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" has invalid priority "high" (must be a finite number).`,
			);
		});

		it("rejects an Infinity priority", () => {
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, priority: Infinity } },
			});
			// `JSON.stringify(Infinity)` is the string "null" per the JSON
			// spec; safeStringify passes that through unchanged.
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" has invalid priority null (must be a finite number).`,
			);
		});

		it("rejects a NaN priority", () => {
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, priority: Number.NaN } },
			});
			expect(error.message).toContain(`hook "h" has invalid priority`);
			expect(error.message).toContain(`must be a finite number`);
		});

		it("rejects a negative timeout", () => {
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, timeout: -100 } },
			});
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" has invalid timeout -100 (must be a non-negative finite number).`,
			);
		});

		it("rejects a non-array dependencies", () => {
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, dependencies: "single" } },
			});
			expect(error.message).toContain(`hook "h" has invalid dependencies "single"`);
		});

		it("rejects a non-boolean exclusive", () => {
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, exclusive: "yes" } },
			});
			expect(error.message).toContain(`hook "h" has invalid exclusive "yes"`);
		});

		it("renders a BigInt field value as <n>n", () => {
			// `JSON.stringify` throws on BigInt; safeStringify marshals
			// it through a JSON replacer that emits the `10n` notation.
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, priority: 10n } },
			});
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" has invalid priority "10n" (must be a finite number).`,
			);
		});

		it("renders a function field value as 'function'", () => {
			// `JSON.stringify(fn)` returns the JS value `undefined`;
			// safeStringify falls back to `describeShape`.
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, priority: (): void => {} } },
			});
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" has invalid priority function (must be a finite number).`,
			);
		});

		it("renders a symbol field value as 'symbol'", () => {
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, priority: Symbol("x") } },
			});
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" has invalid priority symbol (must be a finite number).`,
			);
		});

		it("renders a cyclic-object field value as 'object'", () => {
			// `JSON.stringify` throws on cyclic structures; safeStringify
			// catches and falls back to `describeShape`.
			const cycle: Record<string, unknown> = {};
			cycle.self = cycle;
			const error = expectFailure({
				hooks: { h: { handler: (): void => {}, priority: cycle } },
			});
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: hook "h" has invalid priority object (must be a finite number).`,
			);
		});

		it("displays the whole array when a single element of dependencies is bad", () => {
			// The issue path is `["hooks","h","dependencies",1]`; the
			// displayed value is the field as a whole rather than the
			// offending element. The Zod message names the actual fault.
			const error = expectFailure({
				hooks: {
					h: { handler: (): void => {}, dependencies: ["a", 42, "c"] },
				},
			});
			expect(error.message).toContain(`hook "h" has invalid dependencies[1] ["a",42,"c"]`);
			expect(error.message).toContain("expected string");
		});

		it("surfaces exactly one issue when multiple fields are bad", () => {
			const error = expectFailure({
				hooks: {
					h: { handler: (): void => {}, priority: "high", errorPolicy: "bogus" },
				},
			});
			// Don't lock in *which* field surfaces first (Zod issue order
			// is an implementation detail); enforce that only one does.
			const matches = error.message.match(/has invalid /g);
			expect(matches).toHaveLength(1);
			expect(error.message).toMatch(/hook "h" has invalid (priority|errorPolicy)/);
		});
	});

	describe("route validation errors", () => {
		it("rejects a non-function/non-object route entry", () => {
			const error = expectFailure({ routes: { ping: 42 } });
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: route "ping" must be a function or { handler: function, ... }. Got number.`,
			);
		});

		it("rejects a route entry missing its handler", () => {
			const error = expectFailure({ routes: { ping: { public: true } } });
			expect(error.message).toBe(
				`${PLUGIN_ENTRY}: route "ping" has invalid handler undefined (must be a function).`,
			);
		});

		it("rejects a non-boolean public flag", () => {
			const error = expectFailure({
				routes: { ping: { handler: (): void => {}, public: "yes" } },
			});
			expect(error.message).toContain(`route "ping" has invalid public "yes"`);
		});
	});

	describe("non-record collection coercion", () => {
		// A malformed `hooks` / `routes` outer collection harvests no
		// entries but doesn't fail the build. Entries themselves are
		// still strictly validated.
		it("treats an array hooks field as empty", () => {
			const result = parseProbedDefault(PLUGIN_ENTRY, { hooks: [] });
			expect(result.hooks).toEqual({});
		});

		it("treats a string hooks field as empty", () => {
			const result = parseProbedDefault(PLUGIN_ENTRY, { hooks: "nope" });
			expect(result.hooks).toEqual({});
		});

		it("treats a null hooks field as empty", () => {
			const result = parseProbedDefault(PLUGIN_ENTRY, { hooks: null });
			expect(result.hooks).toEqual({});
		});

		it("treats a string routes field as empty", () => {
			const result = parseProbedDefault(PLUGIN_ENTRY, { routes: "all of them" });
			expect(result.routes).toEqual({});
		});

		it("treats a number routes field as empty", () => {
			const result = parseProbedDefault(PLUGIN_ENTRY, { routes: 42 });
			expect(result.routes).toEqual({});
		});
	});
});
