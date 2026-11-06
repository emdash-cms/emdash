import type { Kysely } from "kysely";

import { after } from "../after.js";
import { escapeHtml } from "../api/escape.js";
import type { SiteUrlConfig } from "../api/public-url.js";
import { getSiteBaseUrl } from "../api/site-url.js";
import { ContentRepository } from "../database/repositories/content.js";
import { EditorialThreadRepository } from "../database/repositories/editorial-threads.js";
import type { Database } from "../database/types.js";
import type { EmailPipeline } from "../plugins/email.js";
import type { EmailMessage } from "../plugins/types.js";
import {
	extractMentions,
	findEditorialUsers,
	renderMentions,
	type EditorialUser,
} from "./mentions.js";

const NOTIFICATION_SOURCE = "emdash-editorial";
const MAX_EXCERPT_LENGTH = 500;
const CRLF_RE = /[\r\n]+/g;

export interface EditorialCommentCreated {
	threadId: string;
	commentId: string;
}

export interface EditorialNotificationEmail {
	to: string;
	authorName: string;
	mentioned: boolean;
	entryTitle: string;
	excerpt: string;
	link: string;
}

export function buildEditorialNotificationEmail(data: EditorialNotificationEmail): EmailMessage {
	const subject = (
		data.mentioned
			? `${data.authorName} mentioned you on "${data.entryTitle}"`
			: `${data.authorName} commented on "${data.entryTitle}"`
	).replace(CRLF_RE, " ");
	const excerpt =
		data.excerpt.length > MAX_EXCERPT_LENGTH
			? `${data.excerpt.slice(0, MAX_EXCERPT_LENGTH)}…`
			: data.excerpt;
	const action = data.mentioned ? "mentioned you in a comment on" : "commented on";

	const text = [
		`${data.authorName} ${action} "${data.entryTitle}":`,
		"",
		excerpt,
		"",
		`View the thread: ${data.link}`,
	].join("\n");
	const html = [
		`<p><strong>${escapeHtml(data.authorName)}</strong> ${action} &ldquo;${escapeHtml(data.entryTitle)}&rdquo;:</p>`,
		`<blockquote style="border-left:3px solid #ccc;padding-left:12px;margin:12px 0;color:#555;white-space:pre-wrap">${escapeHtml(excerpt)}</blockquote>`,
		`<p><a href="${escapeHtml(data.link)}">View the thread</a></p>`,
	].join("\n");

	return { to: data.to, subject, text, html };
}

async function entryTitle(db: Kysely<Database>, collection: string, entryId: string) {
	const collectionRow = await db
		.selectFrom("_emdash_collections")
		.select(["title_field", "label_singular"])
		.where("slug", "=", collection)
		.executeTakeFirst();
	const item = await new ContentRepository(db).findByIdOrSlugIncludingTrashed(collection, entryId);
	const data = item?.data ?? {};
	for (const key of [collectionRow?.title_field, "title", "name"]) {
		const value = key ? data[key] : undefined;
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return item?.slug || `${collectionRow?.label_singular ?? collection} entry`;
}

/**
 * Emails the people a new comment concerns: users it mentions and earlier
 * participants in its thread, except its author and anyone who can no longer
 * comment. Returns the number of emails sent.
 */
export async function sendEditorialCommentNotifications(
	db: Kysely<Database>,
	email: EmailPipeline,
	input: EditorialCommentCreated & { adminBaseUrl: string },
): Promise<number> {
	if (!email.isAvailable()) return 0;
	const thread = await new EditorialThreadRepository(db).getThread(input.threadId);
	const comment = thread?.comments.find((candidate) => candidate.id === input.commentId);
	if (!thread || !comment?.author || comment.deletedAt !== null) return 0;
	const authorId = comment.author.id;

	const mentioned = new Set(extractMentions(comment.body));
	const recipientIds = new Set(mentioned);
	if (thread.createdBy) recipientIds.add(thread.createdBy);
	for (const earlier of thread.comments) {
		if (earlier.id === comment.id) break;
		if (earlier.author) recipientIds.add(earlier.author.id);
	}
	recipientIds.delete(authorId);
	if (recipientIds.size === 0) return 0;

	const users = await findEditorialUsers(db, [...recipientIds, ...mentioned, authorId]);
	const recipients: EditorialUser[] = [];
	for (const id of recipientIds) {
		const user = users.get(id);
		if (user?.canComment && user.emailVerified && user.email) recipients.push(user);
	}
	if (recipients.length === 0) return 0;

	const names = new Map<string, string>();
	for (const user of users.values()) names.set(user.id, user.name || "a teammate");
	const authorName = names.get(authorId) ?? "Someone";
	const title = await entryTitle(db, thread.collection, thread.entryId);
	const link = `${input.adminBaseUrl}/admin/content/${encodeURIComponent(thread.collection)}/${encodeURIComponent(thread.entryId)}?thread=${encodeURIComponent(thread.id)}`;
	const excerpt = renderMentions(comment.body, names);

	let sent = 0;
	for (const user of recipients) {
		try {
			await email.send(
				buildEditorialNotificationEmail({
					to: user.email,
					authorName,
					mentioned: mentioned.has(user.id),
					entryTitle: title,
					excerpt,
					link,
				}),
				NOTIFICATION_SOURCE,
			);
			sent += 1;
		} catch (error) {
			console.error("[editorial] notification email failed:", error);
		}
	}
	return sent;
}

/** Sends a new comment's notifications after the response, when the site can send email. */
export function queueEditorialCommentNotifications(
	context: {
		db: Kysely<Database>;
		email: EmailPipeline | null;
		request: Request;
		config?: SiteUrlConfig;
	},
	created: EditorialCommentCreated,
): void {
	const { db, email, request, config } = context;
	if (!email?.isAvailable()) return;
	after(async () => {
		try {
			const adminBaseUrl = await getSiteBaseUrl(db, request, config);
			await sendEditorialCommentNotifications(db, email, { ...created, adminBaseUrl });
		} catch (error) {
			console.error("[editorial] notifications failed:", error);
		}
	});
}
