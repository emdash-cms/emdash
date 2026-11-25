import { describe, expect, it } from "vitest";

import { createCommentBody } from "../../../src/api/schemas/comments.js";

describe("createCommentBody", () => {
	const comment = { authorName: "Jane", body: "Great post!" };
	const emailOfLength = (length: number) =>
		"a".repeat(length - "@example.com".length) + "@example.com";

	it("accepts an author email of 254 characters", () => {
		const authorEmail = emailOfLength(254);

		expect(createCommentBody.parse({ ...comment, authorEmail }).authorEmail).toBe(authorEmail);
	});

	it.each([255, 9_900_000])("rejects an author email of %i characters", (length) => {
		const result = createCommentBody.safeParse({ ...comment, authorEmail: emailOfLength(length) });

		expect(result.success).toBe(false);
		expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["authorEmail"]);
	});
});
