/**
 * Cloudflare Email Sending adapter for the publisher-notification subsystem
 * (spec §18/§19, plan W10.5 slice 2). Implements the injected
 * {@link NotificationSender} the gated send core (`notification-send.ts`) drives,
 * turning a {@link ConfirmationPayload} / {@link NoticePayload} into a real
 * message through the `send_email` binding.
 *
 * Transport: the structured `env.EMAIL.send({ to, from, subject, html, text,
 * headers, replyTo })` API (no raw MIME) — multipart html+text is assembled by
 * the platform. Arbitrary external recipients are permitted because the binding
 * is declared without a destination restriction (`{"send_email":[{"name":
 * "EMAIL"}]}`), which requires the sending domain to be onboarded for Email
 * Sending. `from` is a var (`NOTIFICATION_FROM_ADDRESS`) on the onboarded domain,
 * never hardcoded.
 *
 * Every message carries `List-Unsubscribe` + `List-Unsubscribe-Post` (Gmail/Yahoo
 * bulk-sender one-click unsubscribe) pointed at the recipient's capability link.
 *
 * SECURITY: `send()` throws typed errors carrying a `.code`. The returned
 * {@link SendResult} error string is the CODE ONLY — never the provider message,
 * which could echo the recipient address, nor the payload (confirm URL / token /
 * body). That string is persisted verbatim in `notifications.last_error`, so
 * leaking a capability or PII into it would leak to the database. The account
 * hard-bounce/complaint suppression (`E_RECIPIENT_SUPPRESSED`) maps to a
 * `suppress: 'bounce'` discriminant so the orchestration layer records our own
 * suppression and retires the row `undeliverable` — it is never retried.
 */

import type {
	ConfirmationPayload,
	NoticePayload,
	NotificationSender,
	SendResult,
} from "./notification-send.js";

/** Cloudflare account-level hard-bounce / complaint suppression — terminal, must
 * never be retried, and mapped to our own suppression ledger. */
const RECIPIENT_SUPPRESSED = "E_RECIPIENT_SUPPRESSED";

/** Codes we recognise for logging clarity; any other code is passed through as
 * a retryable failure. All are transient/quota except the terminal one above. */
const KNOWN_CODES: ReadonlySet<string> = new Set([
	RECIPIENT_SUPPRESSED,
	"E_RATE_LIMIT_EXCEEDED",
	"E_DAILY_LIMIT_EXCEEDED",
	"E_DELIVERY_FAILED",
	"E_INTERNAL_SERVER_ERROR",
]);

export interface EmailSenderConfig {
	/** The `from` address on the onboarded sending domain. */
	fromAddress: string;
	/** Optional display name shown alongside `fromAddress`. */
	fromName?: string;
	/** Optional `Reply-To` (the monitored reconsideration inbox), so publisher
	 * replies route to a human rather than bouncing off the send-only domain. */
	replyTo?: string;
}

export class CloudflareEmailSender implements NotificationSender {
	readonly #email: SendEmail;
	readonly #config: EmailSenderConfig;

	constructor(email: SendEmail, config: EmailSenderConfig) {
		this.#email = email;
		this.#config = config;
	}

	async sendConfirmation(payload: ConfirmationPayload): Promise<SendResult> {
		const content = confirmationContent(payload);
		return this.#deliver(payload.to, payload.unsubscribeUrl, content);
	}

	async sendNotice(payload: NoticePayload): Promise<SendResult> {
		const content = noticeContent(payload);
		return this.#deliver(payload.to, payload.unsubscribeUrl, content);
	}

	async #deliver(
		to: string,
		unsubscribeUrl: string,
		content: { subject: string; html: string; text: string },
	): Promise<SendResult> {
		try {
			const result = await this.#email.send({
				to,
				from:
					this.#config.fromName !== undefined
						? { name: this.#config.fromName, email: this.#config.fromAddress }
						: this.#config.fromAddress,
				...(this.#config.replyTo !== undefined ? { replyTo: this.#config.replyTo } : {}),
				subject: content.subject,
				html: content.html,
				text: content.text,
				headers: {
					"List-Unsubscribe": `<${unsubscribeUrl}>`,
					"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
				},
			});
			return { ok: true, providerId: result.messageId };
		} catch (error) {
			return mapSendError(error);
		}
	}
}

/** Map a thrown send error to a {@link SendResult}. Only the provider CODE is
 * surfaced — never the message (which can echo the recipient) or the payload. */
function mapSendError(error: unknown): SendResult {
	const code = readErrorCode(error);
	if (code === RECIPIENT_SUPPRESSED) {
		return { ok: false, error: RECIPIENT_SUPPRESSED, suppress: "bounce" };
	}
	if (code !== undefined && KNOWN_CODES.has(code)) return { ok: false, error: code };
	return { ok: false, error: code ?? "E_SEND_FAILED" };
}

function readErrorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const { code } = error;
		if (typeof code === "string") return code;
	}
	return undefined;
}

interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

/**
 * Content-neutral double-opt-in confirmation (spec §18): it asks the recipient
 * to confirm they should receive package-security notices, and carries NO
 * assessment specifics — a third party named in hostile metadata must learn
 * nothing about any subject from this mail.
 */
function confirmationContent(payload: ConfirmationPayload): RenderedEmail {
	const subject = "Confirm emdash plugin security notices";
	const lines = [
		"The emdash plugin labeler sends security notices to the contact addresses published for plugins and publishers.",
		"This address was listed as a contact. To receive those notices, confirm below. If you do nothing, you will not be emailed again.",
		`Confirm: ${payload.confirmUrl}`,
		`Not you, or don't want these? ${payload.notMeUrl}`,
		`Unsubscribe: ${payload.unsubscribeUrl}`,
	];
	const text = lines.join("\n\n") + "\n";
	const html = wrapHtml(
		subject,
		[
			paragraph(
				"The emdash plugin labeler sends security notices to the contact addresses published for plugins and publishers.",
			),
			paragraph(
				"This address was listed as a contact. To receive those notices, confirm below. If you do nothing, you will not be emailed again.",
			),
			action("Confirm notifications", payload.confirmUrl),
			paragraph(
				`Not you, or don't want these? <a href="${escapeAttr(payload.notMeUrl)}">Report this address</a> &middot; <a href="${escapeAttr(payload.unsubscribeUrl)}">Unsubscribe</a>`,
				true,
			),
		].join("\n"),
	);
	return { subject, html, text };
}

/**
 * Substantive notice (spec §18/§19). Carries only the public-safe fields the
 * {@link NoticePayload} allows — subject, label effect, public summary, and the
 * public assessment + reconsideration URLs. NO private evidence or findings; the
 * payload type is the enforcement.
 */
function noticeContent(payload: NoticePayload): RenderedEmail {
	const subject = payload.subject;
	const lines = [
		payload.publicSummary,
		`Effect: ${payload.effect}`,
		`Public assessment: ${payload.assessmentUrl}`,
		`Request reconsideration: ${payload.reconsiderationUrl}`,
		`Unsubscribe: ${payload.unsubscribeUrl}`,
	];
	const text = lines.join("\n\n") + "\n";
	const html = wrapHtml(
		subject,
		[
			paragraph(escapeHtml(payload.publicSummary)),
			paragraph(`<strong>Effect:</strong> ${escapeHtml(payload.effect)}`, true),
			action("View the public assessment", payload.assessmentUrl),
			paragraph(
				`If you believe this is mistaken, <a href="${escapeAttr(payload.reconsiderationUrl)}">request reconsideration</a>.`,
				true,
			),
			paragraph(
				`<a href="${escapeAttr(payload.unsubscribeUrl)}">Unsubscribe from these notices</a>`,
				true,
			),
		].join("\n"),
	);
	return { subject, html, text };
}

function wrapHtml(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/** A paragraph. `trusted` skips escaping when the caller has already escaped the
 * interpolated values and is supplying its own markup (links, `<strong>`). */
function paragraph(content: string, trusted = false): string {
	return `<p>${trusted ? content : escapeHtml(content)}</p>`;
}

function action(label: string, url: string): string {
	return `<p><a href="${escapeAttr(url)}">${escapeHtml(label)}</a></p>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** Attribute-context escape for a URL placed in `href="..."`. */
function escapeAttr(value: string): string {
	return escapeHtml(value);
}
