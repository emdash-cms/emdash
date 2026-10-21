import { describe, expect, it, vi } from "vitest";

import { submitHandler } from "../src/handlers/submit.js";
import { submitSchema } from "../src/schemas.js";
import type { FormDefinition } from "../src/types.js";

function form(emailField: boolean, autoresponder = false): FormDefinition {
	return {
		name: "Contact",
		slug: "contact",
		status: "active",
		pages: [
			{
				fields: [
					{ id: "f1", name: "name", label: "Name", type: "text", required: true, width: "full" },
					...(emailField
						? [
								{
									id: "f2",
									name: "email",
									label: "Email",
									type: "email",
									required: false,
									width: "full",
								},
							]
						: []),
				],
			},
		],
		submissionCount: 0,
		lastSubmissionAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		settings: {
			spamProtection: "none",
			notifyEmails: ["team@example.com", "owner@example.com"],
			digestEnabled: false,
			digestHour: 9,
			retentionDays: 0,
			submitLabel: "Send",
			confirmationMessage: "Thanks",
			...(autoresponder ? { autoresponder: { subject: "Got it", body: "We'll reply soon." } } : {}),
		},
	} as unknown as FormDefinition;
}

/** Parses the body as the route does, so the handler sees the schema's output. */
function context(definition: FormDefinition, data: Record<string, unknown>) {
	const send = vi.fn(async () => {});
	const ctx = {
		input: submitSchema.parse({ formId: "contact", data }),
		storage: {
			forms: {
				get: async (id: string) => (id === "contact" ? definition : null),
				put: async () => {},
				query: async () => ({ items: [] }),
			},
			submissions: { put: async () => {}, count: async () => 1 },
		},
		kv: { get: async () => null },
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		email: { send },
		requestMeta: { ip: "203.0.113.1", userAgent: "test", referer: null, headers: {} },
	};
	return { ctx, send };
}

describe("notification emails", () => {
	it("set Reply-To to the submitter's address", async () => {
		const { ctx, send } = context(form(true), { name: "Jane", email: "jane@example.org" });

		await submitHandler(ctx as never);

		expect(send).toHaveBeenCalledTimes(2);
		for (const [message] of send.mock.calls as unknown as [Record<string, unknown>][]) {
			expect(message).toMatchObject({ replyTo: "jane@example.org" });
		}
		expect(send.mock.calls.map(([message]) => (message as { to: string }).to)).toEqual([
			"team@example.com",
			"owner@example.com",
		]);
	});

	it("have no Reply-To when the optional email field is left empty", async () => {
		const { ctx, send } = context(form(true), { name: "Jane", email: "" });

		await submitHandler(ctx as never);

		expect(send).toHaveBeenCalledTimes(2);
		for (const [message] of send.mock.calls as unknown as [Record<string, unknown>][]) {
			expect(message).not.toHaveProperty("replyTo");
		}
	});

	it.each(['"IT-Support"<someone@example.com>', "jane@example.com,"])(
		"have no Reply-To when the address is not a plain one: %s",
		async (email) => {
			const { ctx, send } = context(form(true, true), { name: "Jane", email });

			await submitHandler(ctx as never);

			// The notifications still go out, and the autoresponder keeps the field's own check.
			expect(send).toHaveBeenCalledTimes(3);
			for (const [message] of send.mock.calls.slice(0, 2) as unknown as [
				Record<string, unknown>,
			][]) {
				expect(message).not.toHaveProperty("replyTo");
			}
			expect(send.mock.calls[2]![0]).toMatchObject({ to: email });
		},
	);

	it("have no Reply-To when the form has no email field", async () => {
		const { ctx, send } = context(form(false), { name: "Jane" });

		await submitHandler(ctx as never);

		expect(send).toHaveBeenCalledTimes(2);
		for (const [message] of send.mock.calls as unknown as [Record<string, unknown>][]) {
			expect(message).not.toHaveProperty("replyTo");
		}
	});
});

describe("autoresponder", () => {
	it("is sent to the submitter, without a Reply-To", async () => {
		const { ctx, send } = context(form(true, true), { name: "Jane", email: "jane@example.org" });

		await submitHandler(ctx as never);

		expect(send).toHaveBeenCalledTimes(3);
		expect(send.mock.calls[2]![0]).toEqual({
			to: "jane@example.org",
			subject: "Got it",
			text: "We'll reply soon.",
		});
	});

	it("is not sent when the submitter left the email field empty", async () => {
		const { ctx, send } = context(form(true, true), { name: "Jane", email: "" });

		await submitHandler(ctx as never);

		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls.map(([message]) => (message as { to: string }).to)).not.toContain("");
	});
});
