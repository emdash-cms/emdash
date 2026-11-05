import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { formsListHandler } from "../src/handlers/forms.js";
import type { FormDefinition } from "../src/types.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret";
const ADMIN = 50;
const EDITOR = 40;

function storedForm(): FormDefinition {
	return {
		name: "Contact",
		slug: "contact",
		pages: [{ fields: [] }],
		settings: {
			confirmationMessage: "Thanks.",
			notifyEmails: ["owner@example.com"],
			digestEnabled: false,
			digestHour: 9,
			webhookUrl: WEBHOOK,
			retentionDays: 30,
			spamProtection: "honeypot",
			submitLabel: "Send",
		},
		status: "active",
		submissionCount: 3,
		lastSubmissionAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function ctxWith(form: FormDefinition, user?: { role: number }): RouteContext {
	return {
		storage: {
			forms: {
				query: async () => ({
					items: [{ id: "form-1", data: form }],
					hasMore: false,
					cursor: undefined,
				}),
			},
		},
		user,
	} as unknown as RouteContext;
}

describe("forms/list webhook URL", () => {
	it("returns the webhook URL to admins", async () => {
		const result = await formsListHandler(ctxWith(storedForm(), { role: ADMIN }));
		expect(result.items[0]?.settings.webhookUrl).toBe(WEBHOOK);
	});

	it("leaves the webhook URL out for editors and keeps the other settings", async () => {
		const result = await formsListHandler(ctxWith(storedForm(), { role: EDITOR }));
		const item = result.items[0];
		expect(item?.settings).not.toHaveProperty("webhookUrl");
		expect(item?.settings.notifyEmails).toEqual(["owner@example.com"]);
		expect(item?.name).toBe("Contact");
		expect(item?.id).toBe("form-1");
	});

	it("leaves the webhook URL out when the request has no user", async () => {
		const result = await formsListHandler(ctxWith(storedForm()));
		expect(result.items[0]?.settings).not.toHaveProperty("webhookUrl");
	});

	it("does not mutate the stored form", async () => {
		const stored = storedForm();
		await formsListHandler(ctxWith(stored, { role: EDITOR }));
		expect(stored.settings.webhookUrl).toBe(WEBHOOK);
	});
});
