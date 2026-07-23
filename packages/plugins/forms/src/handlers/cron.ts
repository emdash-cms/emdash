/**
 * Cron task handlers.
 *
 * - cleanup: Delete submissions past their retention period
 * - digest: Send daily digest emails for forms with digest enabled
 */

import type { PluginContext, StorageCollection } from "emdash";

import { formatDigestText } from "../format.js";
export { handleDelivery } from "../outbox.js";
import type { DeliveryDestination, FormDefinition, Submission } from "../types.js";

export const TERMINAL_DELIVERY_RETENTION_DAYS = 30;

/** Typed access to plugin storage collections */
function forms(ctx: PluginContext): StorageCollection<FormDefinition> {
	return ctx.storage.forms as StorageCollection<FormDefinition>;
}

function submissions(ctx: PluginContext): StorageCollection<Submission> {
	return ctx.storage.submissions as StorageCollection<Submission>;
}

/**
 * Weekly cleanup: delete submissions past retention period.
 */
export async function handleCleanup(ctx: PluginContext) {
	let formsCursor: string | undefined;

	do {
		const formsBatch = await forms(ctx).query({ limit: 100, cursor: formsCursor });

		for (const formItem of formsBatch.items) {
			const form = formItem.data;
			if (form.settings.retentionDays === 0) continue;

			const cutoff = new Date();
			cutoff.setDate(cutoff.getDate() - form.settings.retentionDays);
			const cutoffStr = cutoff.toISOString();

			let cursor: string | undefined;
			let deletedCount = 0;

			do {
				const batch = await submissions(ctx).query({
					where: {
						formId: formItem.id,
						createdAt: { lt: cutoffStr },
					},
					limit: 100,
					cursor,
				});
				const eligible = batch.items.filter((item) =>
					canDeleteSubmission(item.data, cutoff, new Date()),
				);

				// Delete media files
				if (ctx.media && "delete" in ctx.media) {
					const mediaWithDelete = ctx.media as { delete(id: string): Promise<boolean> };
					for (const item of eligible) {
						if (item.data.files) {
							for (const file of item.data.files) {
								await mediaWithDelete.delete(file.mediaId).catch(() => {});
							}
						}
					}
				}

				const ids = eligible.map((item) => item.id);
				if (ids.length > 0) {
					await submissions(ctx).deleteMany(ids);
					deletedCount += ids.length;
				}

				cursor = batch.cursor;
			} while (cursor);

			// Update form counter
			if (deletedCount > 0) {
				const count = await submissions(ctx).count({ formId: formItem.id });
				await forms(ctx).put(formItem.id, {
					...form,
					submissionCount: count,
				});

				ctx.log.info("Cleaned up expired submissions", {
					formId: formItem.id,
					formName: form.name,
					deleted: deletedCount,
				});
			}
		}

		formsCursor = formsBatch.cursor;
	} while (formsCursor);
}

function latestTimestamp(
	destinations: DeliveryDestination[],
	field: "deliveredAt" | "terminalAt",
): Date | null {
	const value = destinations
		.map((destination) => destination[field])
		.filter((timestamp): timestamp is string => timestamp !== null)
		.toSorted()
		.at(-1);
	if (!value) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}

function canDeleteSubmission(submission: Submission, formCutoff: Date, now: Date): boolean {
	if (!submission.delivery || !submission.deliveryStatus) {
		return new Date(submission.createdAt) < formCutoff;
	}

	if (
		submission.deliveryStatus === "pending" ||
		submission.deliveryStatus === "processing" ||
		submission.deliveryStatus === "retrying"
	) {
		return false;
	}

	if (submission.deliveryStatus === "delivered") {
		const deliveredAt = latestTimestamp(submission.delivery.destinations, "deliveredAt");
		return deliveredAt !== null && deliveredAt < formCutoff;
	}

	const terminalAt = latestTimestamp(submission.delivery.destinations, "terminalAt");
	if (!terminalAt) return false;
	const terminalCutoff = new Date(now);
	terminalCutoff.setDate(terminalCutoff.getDate() - TERMINAL_DELIVERY_RETENTION_DAYS);
	return terminalAt < formCutoff && terminalAt < terminalCutoff;
}

/**
 * Daily digest: send summary email for a specific form.
 *
 * The cron task name contains the form ID: "digest:{formId}"
 */
export async function handleDigest(formId: string, ctx: PluginContext) {
	const form = await forms(ctx).get(formId);
	if (!form) {
		ctx.log.warn("Digest: form not found, cancelling", { formId });
		if (ctx.cron) {
			await ctx.cron.cancel(`digest:${formId}`).catch(() => {});
		}
		return;
	}

	if (!form.settings.digestEnabled || form.settings.notifyEmails.length === 0) {
		return;
	}

	if (!ctx.email) {
		ctx.log.warn("Digest: email not configured", { formId });
		return;
	}

	// Get submissions since last 24 hours
	const since = new Date();
	since.setDate(since.getDate() - 1);

	const recent = await submissions(ctx).query({
		where: {
			formId,
			createdAt: { gte: since.toISOString() },
		},
		orderBy: { createdAt: "desc" },
		limit: 100,
	});

	if (recent.items.length === 0) {
		return;
	}

	const subs = recent.items.map((item) => item.data);
	const text = formatDigestText(form, formId, subs, ctx.site.url);

	for (const email of form.settings.notifyEmails) {
		await ctx.email
			.send({
				to: email,
				subject: `Daily digest: ${form.name} (${subs.length} new)`,
				text,
			})
			.catch((err: unknown) => {
				ctx.log.error("Failed to send digest email", {
					error: String(err),
					to: email,
				});
			});
	}
}
