import { describe, expect, it } from "vitest";

import type { PublicFormDefinition } from "../src/public-definition.js";
import { parsePublicFormDefinitionResponse } from "../src/public-definition.js";

const activeForm: PublicFormDefinition = {
	name: "Contact",
	slug: "contact",
	pages: [
		{
			fields: [
				{
					id: "email",
					type: "email",
					label: "Email",
					name: "email",
					required: true,
					width: "full",
				},
			],
		},
	],
	settings: {
		spamProtection: "none",
		submitLabel: "Send",
	},
	status: "active",
	_turnstileSiteKey: null,
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("parsePublicFormDefinitionResponse", () => {
	it("unwraps public plugin route responses from the standard API envelope", async () => {
		await expect(
			parsePublicFormDefinitionResponse(jsonResponse({ data: activeForm })),
		).resolves.toEqual(activeForm);
	});

	it("returns null for missing form data", async () => {
		await expect(
			parsePublicFormDefinitionResponse(jsonResponse({ data: undefined })),
		).resolves.toBeNull();
	});

	it("returns null for inactive forms and failed responses", async () => {
		await expect(
			parsePublicFormDefinitionResponse(
				jsonResponse({ data: { ...activeForm, status: "paused" } }),
			),
		).resolves.toBeNull();

		await expect(
			parsePublicFormDefinitionResponse(jsonResponse({ error: { message: "Not found" } }, 404)),
		).resolves.toBeNull();
	});
});
