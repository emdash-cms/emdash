/**
 * Wrapper marshalRequestInit Tests
 *
 * Verifies that marshalRequestInit (generated inside the plugin wrapper
 * template) correctly serializes RequestInit objects into a JSON-safe
 * shape. Regression coverage for the URLSearchParams branch which
 * previously assigned content-type as an object property on what is
 * actually an array, silently dropping the header from POSTs.
 */

import { describe, it, expect } from "vitest";

import { generatePluginWrapper } from "../src/sandbox/wrapper.js";

function extractMarshalRequestInit(): (init: unknown) => Promise<any> {
	const src = generatePluginWrapper(
		{
			id: "test-plugin",
			name: "test",
			version: "1.0.0",
			capabilities: [],
			storage: [],
		} as any,
		{
			backingServiceUrl: "http://127.0.0.1:1",
			authToken: "x",
			invokeToken: "y",
		},
	);
	// The wrapper renders marshalRequestInit (with its helpers nested
	// inside) as a standalone async function literal. Slice it out by
	// brace-counting from the function declaration so we can evaluate it.
	const marker = "async function marshalRequestInit(init) {";
	const startIdx = src.indexOf(marker);
	if (startIdx === -1) {
		throw new Error("marshalRequestInit not found in wrapper output");
	}
	const openBraceIdx = src.indexOf("{", startIdx);
	let depth = 0;
	let endIdx = -1;
	for (let i = openBraceIdx; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				endIdx = i;
				break;
			}
		}
	}
	if (endIdx === -1) {
		throw new Error("Could not find matching closing brace for marshalRequestInit");
	}
	const body = src.slice(startIdx, endIdx + 1);
	// Intentional: marshalRequestInit lives inside a template literal that
	// produces the wrapper module. To exercise it directly we evaluate the
	// extracted function definition in an isolated scope.
	// eslint-disable-next-line no-implied-eval
	const factory = new Function(`${body}\nreturn marshalRequestInit;`);
	return factory();
}

describe("marshalRequestInit: URLSearchParams body", () => {
	it("sets content-type as an array pair (not an object property)", async () => {
		const marshal = extractMarshalRequestInit();
		const result = await marshal({
			method: "POST",
			body: new URLSearchParams({ a: "1", b: "2" }),
		});
		expect(result.bodyType).toBe("string");
		expect(result.body).toBe("a=1&b=2");
		expect(Array.isArray(result.headers)).toBe(true);
		expect(result.headers).toContainEqual(["content-type", "application/x-www-form-urlencoded"]);
		// The previous bug set out.headers["content-type"] on an array;
		// JSON.stringify of arrays drops non-index properties. Verify the
		// header survives a JSON round-trip (which is how it's sent over
		// the bridge to the Node backing service).
		const roundtripped = JSON.parse(JSON.stringify(result));
		expect(roundtripped.headers).toContainEqual([
			"content-type",
			"application/x-www-form-urlencoded",
		]);
	});

	it("preserves caller-provided content-type instead of overwriting", async () => {
		const marshal = extractMarshalRequestInit();
		const result = await marshal({
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: new URLSearchParams({ x: "1" }),
		});
		const ctEntries = result.headers.filter(
			([k]: [string, string]) => k.toLowerCase() === "content-type",
		);
		expect(ctEntries).toHaveLength(1);
		expect(ctEntries[0][1]).toBe("text/plain");
	});

	it("works when no headers were provided by the caller", async () => {
		const marshal = extractMarshalRequestInit();
		const result = await marshal({ body: new URLSearchParams({ x: "1" }) });
		expect(Array.isArray(result.headers)).toBe(true);
		expect(result.headers).toContainEqual(["content-type", "application/x-www-form-urlencoded"]);
	});
});
