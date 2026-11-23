import { describe, expect, it } from "vitest";

import app from "../src/app.js";

describe("read-only marketplace", () => {
	it.each([
		["POST", "/api/v1/auth/github"],
		["POST", "/api/v1/auth/github/device"],
		["POST", "/api/v1/plugins"],
		["PUT", "/api/v1/plugins/example"],
		["POST", "/api/v1/plugins/example/versions"],
		["POST", "/api/v1/plugins/example/installs"],
		["POST", "/api/v1/themes"],
		["PUT", "/api/v1/themes/example/images"],
		["DELETE", "/api/v1/plugins/example"],
		["GET", "/api/v1/auth/discovery"],
		["GET", "/api/v1/plugins/example/versions/1.0.0/audit"],
	])("rejects %s %s with 410", async (method, path) => {
		const res = await app.request(path, { method });
		expect(res.status).toBe(410);
		const body: { error: string } = await res.json();
		expect(body.error).toContain("plugin registry");
	});

	it("still answers health checks", async () => {
		const res = await app.request("/health");
		expect(res.status).toBe(200);
	});
});
