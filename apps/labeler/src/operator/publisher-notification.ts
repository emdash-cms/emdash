import { CODE_FINDING_CATEGORIES } from "@emdash-cms/registry-moderation";

export const PUBLISHER_NOTIFICATION_SENDER = {
	email: "plugin-notify@emdashcms.com",
	name: "EmDash plugin registry",
};

const MAX_RECIPIENTS = 5;
const MAX_EMAIL_LENGTH = 254;
const STALE_SENDING_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]+$/;
const PACKAGE_LINE_REF_RE = /^release\.package:(.+)#L([0-9]+)$/;
const PACKAGE_ENTRY_REF_RE = /^release\.package:entry\[([0-9]+)\]$/;

const CATEGORY_LABELS: Record<string, string> = {
	"malicious-code": "Malicious code",
	vulnerability: "Vulnerability",
	"reviewer-manipulation": "Text aimed at reviewers",
	"package-integrity": "Package integrity",
};

/** The subset of the `send_email` binding this module uses. */
export interface PublisherEmailSender {
	send(message: {
		to: string[];
		from: { email: string; name: string };
		subject: string;
		text: string;
		html: string;
	}): Promise<{ messageId: string }>;
}

export interface NotificationFinding {
	category: string;
	severity: string | null;
	summary: string;
	evidenceRefs: readonly string[];
}

export interface PublisherNotificationDraft {
	recipients: string[];
	subject: string;
	text: string;
	html: string;
}

export interface PublisherNotificationRecord {
	status: "sending" | "sent" | "failed";
	recipients: string[];
	actorDid: string;
	claimedAt: string;
	sentAt: string | null;
	errorCode: string | null;
}

export type PublisherNotificationResult =
	| { ok: true; replayed: boolean; messageId: string; recipients: string[]; sentAt: string }
	| { ok: false; code: PublisherNotificationErrorCode };

export type PublisherNotificationErrorCode =
	| "NO_CODE_FINDINGS"
	| "NO_SECURITY_CONTACT"
	| "ALREADY_NOTIFIED"
	| "NOTIFICATION_IN_PROGRESS"
	| "IDEMPOTENCY_CONFLICT"
	| "EMAIL_SEND_FAILED";

/**
 * Code findings only. Listing findings are not sent to publishers, and neither
 * is a reviewer model declining to review, which says nothing the publisher can fix.
 */
export function codeFindings(findings: readonly NotificationFinding[]): NotificationFinding[] {
	const categories: readonly string[] = CODE_FINDING_CATEGORIES;
	return findings.filter(
		(finding) => finding.category !== "review-declined" && categories.includes(finding.category),
	);
}

/** Email addresses from a package profile's `security` contacts, validated and deduplicated. */
export function securityEmails(profile: unknown): string[] {
	if (!isRecord(profile) || !Array.isArray(profile["security"])) return [];
	const seen = new Set<string>();
	const emails: string[] = [];
	for (const contact of profile["security"]) {
		const email = isRecord(contact) ? contact["email"] : undefined;
		if (typeof email !== "string") continue;
		const trimmed = email.trim();
		const key = trimmed.toLowerCase();
		if (trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(trimmed) || seen.has(key)) continue;
		seen.add(key);
		emails.push(trimmed);
		if (emails.length === MAX_RECIPIENTS) break;
	}
	return emails;
}

/**
 * The email a publisher receives. It carries each code finding's category,
 * severity, summary and cited lines, but not the reviewer models, confidence
 * or the operator's reason.
 */
export function draftPublisherNotification(input: {
	subjectUri: string;
	packageName: string;
	version: string;
	recipients: string[];
	findings: readonly NotificationFinding[];
}): PublisherNotificationDraft {
	const { packageName, version } = input;
	const items = input.findings.map((finding) => ({
		heading: `${CATEGORY_LABELS[finding.category] ?? finding.category}${
			finding.severity ? ` (${finding.severity} severity)` : ""
		}`,
		summary: finding.summary,
		evidence: finding.evidenceRefs.map(describeEvidence),
	}));
	const intro = [
		"Hello,",
		`The EmDash plugin registry's automated review held release ${version} of ${packageName} for operator review. A registry operator has looked at the findings and is sharing them with you as the package's security contact.`,
		`Release: ${input.subjectUri}`,
	];
	const outro = [
		"If you think a finding is wrong, reply to this email and tell us why. If it is right, publish a fixed release; new releases are reviewed again.",
		"EmDash plugin registry",
	];
	const text = [
		...intro,
		"Findings:",
		items
			.map((item, index) =>
				[
					`${index + 1}. ${item.heading}`,
					`   ${item.summary}`,
					...(item.evidence.length > 0 ? [`   Evidence: ${item.evidence.join("; ")}`] : []),
				].join("\n"),
			)
			.join("\n\n"),
		...outro,
	].join("\n\n");
	const html = [
		...intro.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
		"<p>Findings:</p>",
		`<ol>${items
			.map(
				(item) =>
					`<li><p><strong>${escapeHtml(item.heading)}</strong></p><p>${escapeHtml(item.summary)}</p>${
						item.evidence.length > 0
							? `<p>Evidence: ${item.evidence.map(escapeHtml).join("; ")}</p>`
							: ""
					}</li>`,
			)
			.join("")}</ol>`,
		...outro.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
	].join("\n");
	return {
		recipients: input.recipients,
		subject: `Review findings for ${packageName} ${version} on the EmDash plugin registry`,
		text,
		html,
	};
}

export async function readPublisherNotification(
	db: D1Database,
	runKey: string,
): Promise<PublisherNotificationRecord | null> {
	const row = await db
		.prepare(
			`SELECT status, recipients_json, actor_did, claimed_at, sent_at, error_code
			 FROM publisher_notifications WHERE run_key = ?`,
		)
		.bind(runKey)
		.first<{
			status: PublisherNotificationRecord["status"];
			recipients_json: string;
			actor_did: string;
			claimed_at: string;
			sent_at: string | null;
			error_code: string | null;
		}>();
	if (!row) return null;
	return {
		status: row.status,
		recipients: parseRecipients(row.recipients_json),
		actorDid: row.actor_did,
		claimedAt: row.claimed_at,
		sentAt: row.sent_at,
		errorCode: row.error_code,
	};
}

/**
 * Sends a drafted notification at most once per assessment run. A failed or
 * abandoned attempt can be retried; a sent one cannot. Replaying the same
 * idempotency key returns the original result without sending again.
 */
export async function sendPublisherNotification(input: {
	db: D1Database;
	sender: PublisherEmailSender;
	runKey: string;
	subject: { uri: string; cid: string };
	draft: PublisherNotificationDraft;
	actorDid: string;
	actorRole: "reviewer" | "admin";
	reason: string;
	idempotencyKey: string;
	now: Date;
}): Promise<PublisherNotificationResult> {
	const { db, draft, now } = input;
	const prior = await db
		.prepare(
			`SELECT run_key, status, message_id, recipients_json, sent_at
			 FROM publisher_notifications WHERE idempotency_key = ?`,
		)
		.bind(input.idempotencyKey)
		.first<{
			run_key: string;
			status: string;
			message_id: string | null;
			recipients_json: string;
			sent_at: string | null;
		}>();
	if (prior) {
		if (prior.run_key !== input.runKey) return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
		if (prior.status === "sent" && prior.message_id && prior.sent_at) {
			return {
				ok: true,
				replayed: true,
				messageId: prior.message_id,
				recipients: parseRecipients(prior.recipients_json),
				sentAt: prior.sent_at,
			};
		}
		return {
			ok: false,
			code: prior.status === "sending" ? "NOTIFICATION_IN_PROGRESS" : "EMAIL_SEND_FAILED",
		};
	}

	const claimedAt = now.toISOString();
	const claimed = await db
		.prepare(
			`INSERT INTO publisher_notifications (
				run_key, subject_uri, subject_cid, recipients_json, actor_did, actor_role,
				reason, idempotency_key, status, claimed_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?)
			 ON CONFLICT (run_key) DO UPDATE SET
				subject_uri = excluded.subject_uri,
				subject_cid = excluded.subject_cid,
				recipients_json = excluded.recipients_json,
				actor_did = excluded.actor_did,
				actor_role = excluded.actor_role,
				reason = excluded.reason,
				idempotency_key = excluded.idempotency_key,
				status = 'sending',
				message_id = NULL,
				error_code = NULL,
				claimed_at = excluded.claimed_at,
				sent_at = NULL
			 WHERE publisher_notifications.status = 'failed'
				OR (publisher_notifications.status = 'sending' AND publisher_notifications.claimed_at < ?)
			 RETURNING id`,
		)
		.bind(
			input.runKey,
			input.subject.uri,
			input.subject.cid,
			JSON.stringify(draft.recipients),
			input.actorDid,
			input.actorRole,
			input.reason,
			input.idempotencyKey,
			claimedAt,
			new Date(now.getTime() - STALE_SENDING_MS).toISOString(),
		)
		.first<{ id: number }>();
	if (!claimed) {
		const existing = await readPublisherNotification(db, input.runKey);
		return {
			ok: false,
			code: existing?.status === "sent" ? "ALREADY_NOTIFIED" : "NOTIFICATION_IN_PROGRESS",
		};
	}

	let messageId: string;
	try {
		({ messageId } = await input.sender.send({
			to: draft.recipients,
			from: PUBLISHER_NOTIFICATION_SENDER,
			subject: draft.subject,
			text: draft.text,
			html: draft.html,
		}));
	} catch (error) {
		const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : "UNKNOWN";
		await db
			.prepare("UPDATE publisher_notifications SET status = 'failed', error_code = ? WHERE id = ?")
			.bind(code.slice(0, 64), claimed.id)
			.run();
		console.error(
			JSON.stringify({
				event: "publisher_notification_failed",
				runKey: input.runKey,
				code,
			}),
		);
		return { ok: false, code: "EMAIL_SEND_FAILED" };
	}
	const sentAt = now.toISOString();
	await recordSent(db, claimed.id, messageId, sentAt, input.runKey);
	return { ok: true, replayed: false, messageId, recipients: draft.recipients, sentAt };
}

const RECORD_SENT_ATTEMPTS = 3;

// The email has already gone out, so a lost update would let a stale claim resend it.
async function recordSent(
	db: D1Database,
	id: number,
	messageId: string,
	sentAt: string,
	runKey: string,
): Promise<void> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- retries one write in order
			await db
				.prepare(
					"UPDATE publisher_notifications SET status = 'sent', message_id = ?, sent_at = ? WHERE id = ?",
				)
				.bind(messageId, sentAt, id)
				.run();
			return;
		} catch (error) {
			if (attempt >= RECORD_SENT_ATTEMPTS) {
				console.error(
					JSON.stringify({ event: "publisher_notification_unrecorded", runKey, messageId }),
					error,
				);
				return;
			}
		}
	}
}

function describeEvidence(ref: string): string {
	const line = PACKAGE_LINE_REF_RE.exec(ref);
	if (line) return `${line[1]} line ${line[2]}`;
	const entry = PACKAGE_ENTRY_REF_RE.exec(ref);
	if (entry) return `archive entry ${Number(entry[1]) + 1}`;
	return ref;
}

function parseRecipients(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
