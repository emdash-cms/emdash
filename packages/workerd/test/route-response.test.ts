import { describe, expect, it } from "vitest";

import { readRouteResponse } from "../src/sandbox/route-response.js";

const validEnvelope = {
	status: 200,
	statusText: "OK",
	headers: [["Content-Type", "text/plain"]],
	body: [111, 107],
};

function transportResponse(value: unknown) {
	return Response.json(value, { headers: { "X-EmDash-Raw-Response": "1" } });
}

describe("readRouteResponse", () => {
	it.each([
		["envelope", { ...validEnvelope, status: "200" }],
		["headers", { ...validEnvelope, headers: [["Content-Type"]] }],
		["body", { ...validEnvelope, body: [256] }],
	])("rejects malformed %s data", async (_name, value) => {
		await expect(readRouteResponse(transportResponse(value))).rejects.toThrow();
	});
});
