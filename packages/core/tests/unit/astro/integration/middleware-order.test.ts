import { describe, expect, it } from "vitest";

import { buildMiddlewareEntries } from "../../../../src/astro/integration/index.js";

const defaultEntries = [
	{ entrypoint: "emdash/middleware", order: "pre" },
	{ entrypoint: "emdash/middleware/redirect", order: "pre" },
	{ entrypoint: "emdash/middleware/setup", order: "pre" },
	{ entrypoint: "emdash/middleware/auth", order: "pre" },
	{ entrypoint: "emdash/middleware/media-usage-write-fence", order: "pre" },
	{ entrypoint: "emdash/middleware/request-context", order: "pre" },
] as const;
const root = new URL("file:///project/");
const invalidMiddleware: Array<[string, unknown]> = [
	["a missing outer entrypoint", {}],
	["a null middleware config", null],
	["an empty entrypoint", { outer: "" }],
	["a whitespace-only entrypoint", { outer: " " }],
	["a non-string entrypoint", { outer: 42 }],
];

describe("EmDash middleware registration order", () => {
	it("preserves the existing middleware order when no outer middleware is configured", () => {
		expect(buildMiddlewareEntries({}, root)).toEqual(defaultEntries);
	});

	it("registers the user middleware outside the complete EmDash stack", () => {
		expect(
			buildMiddlewareEntries(
				{
					middleware: { outer: "./src/outer-middleware.ts" },
				},
				root,
			),
		).toEqual([
			{ entrypoint: new URL("file:///project/src/outer-middleware.ts"), order: "pre" },
			...defaultEntries,
		]);
	});

	it("preserves package middleware specifiers", () => {
		expect(
			buildMiddlewareEntries({ middleware: { outer: "@example/outer-middleware" } }, root),
		).toEqual([{ entrypoint: "@example/outer-middleware", order: "pre" }, ...defaultEntries]);
	});

	it.each(invalidMiddleware)("rejects %s", (_label, middleware) => {
		// @ts-expect-error - runtime validation covers untyped JavaScript configuration
		const build = () => buildMiddlewareEntries({ middleware }, root);
		expect(build).toThrow("middleware.outer must be a non-empty module specifier string or URL");
	});

	it("places the outer middleware before the playground database middleware", () => {
		expect(
			buildMiddlewareEntries(
				{
					middleware: { outer: "./src/outer-middleware.ts" },
					playground: { middlewareEntrypoint: "playground/middleware" },
				},
				root,
			),
		).toEqual([
			{ entrypoint: new URL("file:///project/src/outer-middleware.ts"), order: "pre" },
			{ entrypoint: "playground/middleware", order: "pre" },
			{ entrypoint: "emdash/middleware", order: "pre" },
			{ entrypoint: "emdash/middleware/redirect", order: "pre" },
			{ entrypoint: "emdash/middleware/media-usage-write-fence", order: "pre" },
			{ entrypoint: "emdash/middleware/request-context", order: "pre" },
		]);
	});
});
