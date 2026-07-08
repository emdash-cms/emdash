import { describe, it, expect } from "vitest";

import { previewDatabase, playgroundDatabase } from "../src/index.js";

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
