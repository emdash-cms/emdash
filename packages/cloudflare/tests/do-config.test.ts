import { describe, it, expect } from "vitest";

import { d1, durableObjects, previewDatabase, playgroundDatabase } from "../src/index.js";

describe("d1()", () => {
	it("opts into request-scoped and coalescing dialects", () => {
		const result = d1({ binding: "DB" });
		expect(result.supportsRequestScope).toBe(true);
		expect(result.supportsCoalescing).toBe(true);
	});
});

describe("durableObjects()", () => {
	it("opts into request-scoped and coalescing dialects", () => {
		const result = durableObjects({ binding: "DB_DO" });
		expect(result.supportsRequestScope).toBe(true);
		expect(result.supportsCoalescing).toBe(true);
	});
});

describe("previewDatabase()", () => {
	it("returns a sqlite DatabaseDescriptor with the DO entrypoint", () => {
		const result = previewDatabase({ binding: "PREVIEW_DB" });
		expect(result).toEqual({
			entrypoint: "@emdash-cms/cloudflare/db/do",
			config: { binding: "PREVIEW_DB" },
			type: "sqlite",
		});
	});
});

describe("playgroundDatabase()", () => {
	it("returns a sqlite DatabaseDescriptor with the playground entrypoint", () => {
		const result = playgroundDatabase({ binding: "PLAYGROUND_DB" });
		expect(result).toEqual({
			entrypoint: "@emdash-cms/cloudflare/db/playground",
			config: { binding: "PLAYGROUND_DB" },
			type: "sqlite",
		});
	});
});
