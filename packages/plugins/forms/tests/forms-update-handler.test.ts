import { describe, expect, it } from "vitest";

import { formsUpdateHandler } from "../src/handlers/forms.js";
import { formUpdateSchema } from "../src/schemas.js";
import type { FormDefinition } from "../src/types.js";

const stored: FormDefinition = {
	name: "F",
	slug: "f",
	pages: [
		{ fields: [{ id: "x", type: "text", label: "X", name: "x", required: false, width: "full" }] },
	],
	settings: {
		confirmationMessage: "Thanks",
		notifyEmails: ["notify@example.com"],
		digestEnabled: false,
		digestHour: 9,
		autoresponder: { subject: "Subject", body: "Body" },
		webhookUrl: "https://example.com/hook",
		retentionDays: 0,
		spamProtection: "honeypot",
		submitLabel: "Submit",
	},
	status: "active",
	submissionCount: 0,
	lastSubmissionAt: null,
	createdAt: "now",
	updatedAt: "now",
};

function context(input: unknown) {
	let current = stored;
	const forms = {
		get: async () => current,
		put: async (_id: string, value: FormDefinition) => {
			current = value;
		},
		updateIf: async (_id: string, args: { set?: Partial<FormDefinition> }) => {
			current = { ...current, ...args.set };
			return { applied: true, data: current };
		},
		query: async () => ({ items: [], hasMore: false }),
	};
	return {
		ctx: { input, storage: { forms } } as never,
		forms,
		getCurrent: () => current,
	};
}

describe("forms update boundary", () => {
	it("accepts null autoresponder and an empty webhook while retaining recipients", async () => {
		const parsed = formUpdateSchema.parse({
			id: "f",
			settings: { autoresponder: null, webhookUrl: "" },
		});
		const { ctx, getCurrent } = context(parsed);
		await formsUpdateHandler(ctx);
		const settings = getCurrent().settings;
		expect(settings.autoresponder).toBeUndefined();
		expect(settings.webhookUrl).toBeUndefined();
		expect(settings.notifyEmails).toEqual(["notify@example.com"]);
	});

	it("keeps the stored responder and recipients when updating another setting", async () => {
		const parsed = formUpdateSchema.parse({ id: "f", settings: { retentionDays: 30 } });
		const { ctx, getCurrent } = context(parsed);
		await formsUpdateHandler(ctx);
		expect(getCurrent().settings).toMatchObject({
			autoresponder: stored.settings.autoresponder,
			notifyEmails: stored.settings.notifyEmails,
		});
	});
});
