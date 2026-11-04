import { describe, it, expect } from "vitest";
import { z } from "zod";

import { isParseError, parseBody, parseQuery } from "../../../src/api/parse.js";

/**
 * `parseBody`/`parseQuery` are the shared request validators used by almost
 * every route. Their validation-failure response must carry the documented
 * `{ success: false, error }` envelope so it matches the OpenAPI `ApiError`
 * schema attached to those routes.
 */
describe("request parser validation envelope", () => {
	const schema = z.object({ limit: z.coerce.number().min(1) });

	it("parseQuery returns a { success: false, error } envelope on invalid input", async () => {
		const result = parseQuery(new URL("https://example.com/?limit=0"), schema);
		expect(isParseError(result)).toBe(true);
		if (!isParseError(result)) return;

		expect(result.status).toBe(400);
		const body = await result.json();
		expect(body).toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR", message: "Invalid request data" },
		});
		expect(body.error.details).toHaveProperty("issues");
	});

	it("parseBody returns a { success: false, error } envelope on invalid input", async () => {
		const request = new Request("https://example.com", {
			method: "POST",
			body: JSON.stringify({ limit: -5 }),
			headers: { "Content-Type": "application/json" },
		});
		const result = await parseBody(request, schema);
		expect(isParseError(result)).toBe(true);
		if (!isParseError(result)) return;

		expect(result.status).toBe(400);
		const body = await result.json();
		expect(body).toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR" },
		});
	});
});
