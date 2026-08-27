import { describe, expect, it } from "vitest";

import { parsePinnedHttpResponse } from "../src/assessment/runtime-media.js";

describe("pinned HTTPS response parsing", () => {
	it("parses a bounded content-length response", () => {
		const response = parsePinnedHttpResponse(
			new TextEncoder().encode(
				"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\n\r\ntest",
			),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.body).toEqual(new TextEncoder().encode("test"));
	});

	it("decodes chunked bodies and rejects encoded or ambiguous framing", () => {
		const chunked = parsePinnedHttpResponse(
			new TextEncoder().encode(
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntest\r\n0\r\n\r\n",
			),
		);
		expect(chunked.body).toEqual(new TextEncoder().encode("test"));
		expect(() =>
			parsePinnedHttpResponse(
				new TextEncoder().encode(
					"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 4\r\n\r\ntest",
				),
			),
		).toThrow(/content encoding/);
		expect(() =>
			parsePinnedHttpResponse(
				new TextEncoder().encode(
					"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n",
				),
			),
		).toThrow(/framing/);
	});
});
