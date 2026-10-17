import { describe, expect, it, vi } from "vitest";

vi.mock("wrangler", () => {
	throw new Error("wrangler was loaded during root-entry import");
});

import { d1, kvCache, r2 } from "../src/index.js";

describe("root entry without wrangler", () => {
	it("imports successfully even when wrangler is not available", () => {
		expect(d1).toBeTypeOf("function");
		expect(r2).toBeTypeOf("function");
		expect(kvCache).toBeTypeOf("function");
	});

	it("d1() returns a descriptor without loading wrangler", () => {
		const descriptor = d1({ binding: "DB" });
		expect(descriptor.entrypoint).toBe("@emdash-cms/cloudflare/db/d1");
		expect(descriptor.type).toBe("sqlite");
	});

	it("r2() returns a descriptor without loading wrangler", () => {
		const descriptor = r2({ binding: "MEDIA" });
		expect(descriptor.entrypoint).toBe("@emdash-cms/cloudflare/storage/r2");
	});

	it("kvCache() returns a descriptor without loading wrangler", () => {
		const descriptor = kvCache({ binding: "CACHE" });
		expect(descriptor.entrypoint).toBe("@emdash-cms/cloudflare/cache/kv");
	});
});
