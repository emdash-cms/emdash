import { describe, expect, it } from "vitest";

import { InvalidReviewRequestError, parseRequest } from "../src/request.js";

const VALID = {
	model: "openai/test",
	subject: { uri: "at://did:plc:test/x/y", cid: "bafy", version: "1.0.0" },
	listing: [{ ref: "profile.name", text: "Test" }],
	declaredAccess: {},
	files: [
		{ path: "backend.js", byteLength: 1, text: "x" },
		{ path: "icon.png", byteLength: 4 },
	],
};

describe("parseRequest", () => {
	it("accepts a well-formed request", () => {
		expect(parseRequest(VALID)).toEqual(VALID);
	});

	it.each([
		["a missing model", { ...VALID, model: "" }],
		["a duplicate file", { ...VALID, files: [VALID.files[0], VALID.files[0]] }],
		["no files", { ...VALID, files: [] }],
		["non-string file text", { ...VALID, files: [{ path: "a.js", byteLength: 1, text: 1 }] }],
		["a malformed listing", { ...VALID, listing: [{ ref: "profile.name" }] }],
	])("rejects %s", (_name, request) => {
		expect(() => parseRequest(request)).toThrow(InvalidReviewRequestError);
	});
});
