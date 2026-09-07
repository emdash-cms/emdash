import { describe, expect, it } from "vitest";

import { searchEnableBody } from "../../../src/api/schemas/search.js";

describe("searchEnableBody", () => {
	it.each(["porter unicode61", "unicode61", "trigram"] as const)(
		"accepts the %s tokenizer",
		(tokenize) => {
			expect(
				searchEnableBody.parse({
					collection: "posts",
					enabled: true,
					tokenize,
				}),
			).toEqual({
				collection: "posts",
				enabled: true,
				tokenize,
			});
		},
	);

	it("allows the tokenizer to be omitted", () => {
		expect(
			searchEnableBody.parse({
				collection: "posts",
				enabled: true,
			}),
		).toEqual({
			collection: "posts",
			enabled: true,
		});
	});

	it.each(["porter", "trigram'); DROP TABLE ec_posts; --"])(
		"rejects unsupported tokenizer %s",
		(tokenize) => {
			expect(() =>
				searchEnableBody.parse({
					collection: "posts",
					enabled: true,
					tokenize,
				}),
			).toThrow();
		},
	);
});
