import { describe, expect, it } from "vitest";

import { parseApiResponse } from "../../src/plugin-utils.js";

function htmlErrorPage() {
	// A response received over HTTP/2 or HTTP/3 has an empty statusText.
	return new Response("<html>Bad Gateway</html>", { status: 502, statusText: "" });
}

describe("parseApiResponse", () => {
	it("rejects with the server's error message", async () => {
		const response = Response.json(
			{ success: false, error: { code: "NOT_FOUND", message: "Form not found" } },
			{ status: 404 },
		);
		await expect(parseApiResponse(response, "Failed to load form")).rejects.toThrow(
			/^Form not found$/,
		);
	});

	it.each([
		{
			name: "the given fallback",
			fallback: "Failed to load form",
			expected: "Failed to load form",
		},
		{ name: "the default fallback", fallback: undefined, expected: "Request failed" },
	])("rejects with $name alone for an HTML error page", async ({ fallback, expected }) => {
		await expect(parseApiResponse(htmlErrorPage(), fallback)).rejects.toThrow(
			new RegExp(`^${expected}$`),
		);
	});
});
