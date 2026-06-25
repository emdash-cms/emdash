import { describe, it, expect } from "vitest";

import { hyperdrive } from "../src/index.js";

describe("hyperdrive()", () => {
	it("returns a postgres DatabaseDescriptor with the hyperdrive entrypoint", () => {
		const result = hyperdrive({ binding: "HYPERDRIVE" });
		expect(result).toEqual({
			entrypoint: "@emdash-cms/cloudflare/db/hyperdrive",
			config: { binding: "HYPERDRIVE", max: undefined },
			type: "postgres",
			supportsRequestScope: true,
		});
	});

	it("defaults the binding to HYPERDRIVE", () => {
		const result = hyperdrive();
		expect(result.config).toEqual({ binding: "HYPERDRIVE", max: undefined });
		expect(result.type).toBe("postgres");
	});

	it("passes through a custom binding and pool max", () => {
		const result = hyperdrive({ binding: "PG", max: 10 });
		expect(result.config).toEqual({ binding: "PG", max: 10 });
	});

	it("requests request-scoped db support (per-request pg connections)", () => {
		const result = hyperdrive();
		expect(result.supportsRequestScope).toBe(true);
	});
});
