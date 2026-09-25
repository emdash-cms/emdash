import { describe, expect, it } from "vitest";

import { buildSerializableConfig } from "../../../../src/astro/integration/index.js";

describe("buildSerializableConfig", () => {
	it("passes the update-check opt-out to the runtime config", () => {
		expect(buildSerializableConfig({ updateCheck: false }).updateCheck).toBe(false);
	});
});
