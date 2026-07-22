import { describe, expect, it, vi } from "vitest";

import { safeJsonSchemaToZod } from "../../../src/mcp/json-schema.js";

describe("safeJsonSchemaToZod", () => {
	it("falls back instead of throwing for a malformed serialized schema", () => {
		const onError = vi.fn();
		const fallback = safeJsonSchemaToZod({ type: "definitely-not-json-schema" }, onError);

		expect(() => fallback.parse({ unexpected: true })).not.toThrow();
		expect(onError).toHaveBeenCalledOnce();
	});
});
