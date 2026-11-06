import { describe, expect, it } from "vitest";

import { exportSchema, formCreateSchema, formUpdateSchema } from "../src/schemas.js";

describe("exportSchema", () => {
	it("accepts minute-precision ISO datetime bounds", () => {
		const from = "2026-09-01T14:30Z";
		const to = "2026-09-01T15:30Z";
		expect(exportSchema.parse({ formId: "contact", format: "csv", from, to })).toEqual({
			formId: "contact",
			format: "csv",
			from,
			to,
		});
	});
});

describe("formUpdateSchema", () => {
	it("leaves settings the caller did not send alone", () => {
		// A partial settings update must not carry defaults for the keys it omits: the update handler
		// merges the parse result over the stored settings, so an injected `spamProtection: "honeypot"`
		// silently turns off a form's Turnstile when all the caller wanted was a new notification address.
		const parsed = formUpdateSchema.parse({
			id: "01JBQ8Z0000000000000000000",
			settings: { notifyEmails: ["editor@example.com"] },
		});

		expect(parsed.settings).toEqual({ notifyEmails: ["editor@example.com"] });
	});

	it("still validates the settings it is given", () => {
		expect(() =>
			formUpdateSchema.parse({
				id: "01JBQ8Z0000000000000000000",
				settings: { spamProtection: "captcha" },
			}),
		).toThrow();
	});
});

describe("formCreateSchema", () => {
	it("applies the settings defaults", () => {
		const parsed = formCreateSchema.parse({
			name: "Contact",
			slug: "contact",
			pages: [
				{
					fields: [
						{
							id: "email",
							name: "email",
							label: "Email",
							type: "email",
							required: true,
							width: "full",
						},
					],
				},
			],
			settings: {},
		});

		expect(parsed.settings).toMatchObject({
			confirmationMessage: "Thank you for your submission.",
			notifyEmails: [],
			digestEnabled: false,
			digestHour: 9,
			retentionDays: 0,
			spamProtection: "honeypot",
			submitLabel: "Submit",
		});
	});
});
