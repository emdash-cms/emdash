import { describe, expect, it } from "vitest";

import { CloudflareEmailSender } from "../src/notification-email.js";
import type { ConfirmationPayload, NoticePayload } from "../src/notification-send.js";

/** A fake `SendEmail` binding that records the composed message and either
 * resolves with a messageId or throws a coded error. */
function fakeEmail(behavior: { messageId: string } | { throw: unknown }): {
	binding: SendEmail;
	calls: EmailMessageBuilder[];
} {
	const calls: EmailMessageBuilder[] = [];
	const binding = {
		send: async (message: EmailMessage | EmailMessageBuilder) => {
			calls.push(message as EmailMessageBuilder);
			if ("throw" in behavior) throw behavior.throw;
			return { messageId: behavior.messageId };
		},
	} as unknown as SendEmail;
	return { binding, calls };
}

const CONFIG = {
	fromAddress: "notifications@emdashcms.com",
	fromName: "labeler",
	replyTo: "recon@x",
};

const confirmation: ConfirmationPayload = {
	to: "dev@example.test",
	confirmUrl: "https://labels.example/notifications/confirm?c=abc&t=SECRETTOKEN",
	unsubscribeUrl: "https://labels.example/notifications/unsubscribe?c=abc",
	notMeUrl: "https://labels.example/notifications/not-me?c=abc",
};

const notice: NoticePayload = {
	to: "dev@example.test",
	subject: "Your plugin release was blocked",
	publicSummary: "A security assessment blocked this release.",
	assessmentUrl: "https://labels.example/xrpc/getCurrentAssessment?uri=at://x",
	effect: "The release is blocked.",
	reconsiderationUrl: "https://labels.example/reconsider",
	unsubscribeUrl: "https://labels.example/notifications/unsubscribe?c=abc",
};

describe("CloudflareEmailSender success", () => {
	it("sends a notice with html+text bodies and returns the provider messageId", async () => {
		const email = fakeEmail({ messageId: "msg-1" });
		const sender = new CloudflareEmailSender(email.binding, CONFIG);

		const result = await sender.sendNotice(notice);

		expect(result).toEqual({ ok: true, providerId: "msg-1" });
		expect(email.calls).toHaveLength(1);
		const sent = email.calls[0]!;
		expect(sent.to).toBe("dev@example.test");
		expect(sent.from).toEqual({ name: "labeler", email: "notifications@emdashcms.com" });
		expect(sent.replyTo).toBe("recon@x");
		expect(sent.subject).toBe("Your plugin release was blocked");
		expect(sent.html).toContain("A security assessment blocked this release.");
		expect(sent.text).toContain("A security assessment blocked this release.");
		expect(sent.html?.length).toBeGreaterThan(0);
		expect(sent.text?.length).toBeGreaterThan(0);
	});

	it("sets List-Unsubscribe + one-click headers on every send", async () => {
		const email = fakeEmail({ messageId: "m" });
		const sender = new CloudflareEmailSender(email.binding, CONFIG);

		await sender.sendConfirmation(confirmation);

		const headers = email.calls[0]!.headers ?? {};
		expect(headers["List-Unsubscribe"]).toBe(
			"<https://labels.example/notifications/unsubscribe?c=abc>",
		);
		expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
	});

	it("sends a content-neutral confirmation (no assessment specifics) returning the messageId", async () => {
		const email = fakeEmail({ messageId: "c-1" });
		const sender = new CloudflareEmailSender(email.binding, CONFIG);

		const result = await sender.sendConfirmation(confirmation);

		expect(result).toEqual({ ok: true, providerId: "c-1" });
		const sent = email.calls[0]!;
		// Carries the confirm/opt-out links, but nothing about any assessment.
		expect(sent.text).toContain(confirmation.confirmUrl);
		expect(sent.text).not.toContain("blocked");
		expect(sent.html).not.toContain("blocked");
	});
});

describe("CloudflareEmailSender error mapping", () => {
	it("maps E_RECIPIENT_SUPPRESSED to a bounce-suppression discriminant", async () => {
		const email = fakeEmail({ throw: { code: "E_RECIPIENT_SUPPRESSED" } });
		const sender = new CloudflareEmailSender(email.binding, CONFIG);

		const result = await sender.sendNotice(notice);

		expect(result).toEqual({ ok: false, error: "E_RECIPIENT_SUPPRESSED", suppress: "bounce" });
	});

	it.each([
		"E_RATE_LIMIT_EXCEEDED",
		"E_DAILY_LIMIT_EXCEEDED",
		"E_DELIVERY_FAILED",
		"E_INTERNAL_SERVER_ERROR",
	])("maps %s to a retryable failure with no suppression", async (code) => {
		const email = fakeEmail({ throw: { code } });
		const sender = new CloudflareEmailSender(email.binding, CONFIG);

		const result = await sender.sendNotice(notice);

		expect(result).toEqual({ ok: false, error: code });
	});

	it("maps an unknown/absent code to a generic failure", async () => {
		const email = fakeEmail({ throw: new Error("boom") });
		const sender = new CloudflareEmailSender(email.binding, CONFIG);

		expect(await sender.sendNotice(notice)).toEqual({ ok: false, error: "E_SEND_FAILED" });
	});

	it("NEVER leaks the payload (confirm URL / token) into the error string", async () => {
		// A provider error whose message echoes the recipient + confirm token — the
		// adapter must surface only the code, never this message.
		const email = fakeEmail({
			throw: {
				code: "E_DELIVERY_FAILED",
				message: `failed to deliver to ${confirmation.confirmUrl}`,
			},
		});
		const sender = new CloudflareEmailSender(email.binding, CONFIG);

		const result = await sender.sendConfirmation(confirmation);

		expect(result).toEqual({ ok: false, error: "E_DELIVERY_FAILED" });
		if (!result.ok) {
			expect(result.error).not.toContain("SECRETTOKEN");
			expect(result.error).not.toContain("confirm");
		}
	});
});
