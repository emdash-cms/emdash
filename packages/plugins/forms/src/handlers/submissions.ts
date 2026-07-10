/**
 * Submission management route handlers.
 *
 * Admin-only routes for viewing, updating, exporting, and deleting submissions.
 */

import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";

import { formatCsv } from "../format.js";
import type {
	ExportInput,
	SubmissionDeleteInput,
	SubmissionGetInput,
	SubmissionsListInput,
	SubmissionUpdateInput,
} from "../schemas.js";
import type { FormDefinition, Submission } from "../types.js";

/** Typed access to plugin storage collections */
function forms(ctx: RouteContext): StorageCollection<FormDefinition> {
	return ctx.storage.forms as StorageCollection<FormDefinition>;
}

function submissions(ctx: RouteContext): StorageCollection<Submission> {
	return ctx.storage.submissions as StorageCollection<Submission>;
}

// ─── List Submissions ────────────────────────────────────────────

export async function submissionsListHandler(ctx: RouteContext<SubmissionsListInput>) {
	const input = ctx.input;

	const result = await submissions(ctx).query({
		where: {
			formId: input.formId,
			...(input.status ? { status: input.status } : {}),
			...(input.starred !== undefined ? { starred: input.starred } : {}),
		},
		orderBy: { createdAt: "desc" },
		limit: input.limit,
		cursor: input.cursor,
	});

	return {
		items: result.items.map((item) => ({ id: item.id, ...item.data })),
		hasMore: result.hasMore,
		cursor: result.cursor,
	};
}

// ─── Get Single Submission ───────────────────────────────────────

export async function submissionGetHandler(ctx: RouteContext<SubmissionGetInput>) {
	const sub = await submissions(ctx).get(ctx.input.id);
	if (!sub) {
		throw PluginRouteError.notFound("Submission not found");
	}

	return { id: ctx.input.id, ...sub };
}

// ─── Update Submission ───────────────────────────────────────────

export async function submissionUpdateHandler(ctx: RouteContext<SubmissionUpdateInput>) {
	const input = ctx.input;

	const existing = await submissions(ctx).get(input.id);
	if (!existing) {
		throw PluginRouteError.notFound("Submission not found");
	}

	const updated: Submission = {
		...existing,
		status: input.status ?? existing.status,
		starred: input.starred ?? existing.starred,
		notes: input.notes !== undefined ? input.notes : existing.notes,
	};

	await submissions(ctx).put(input.id, updated);

	return { id: input.id, ...updated };
}

// ─── Delete Submission ───────────────────────────────────────────

export async function submissionDeleteHandler(ctx: RouteContext<SubmissionDeleteInput>) {
	const input = ctx.input;

	const existing = await submissions(ctx).get(input.id);
	if (!existing) {
		throw PluginRouteError.notFound("Submission not found");
	}

	// Delete associated media files
	if (existing.files && ctx.media && "delete" in ctx.media) {
		const mediaWithDelete = ctx.media as { delete(id: string): Promise<boolean> };
		for (const file of existing.files) {
			await mediaWithDelete.delete(file.mediaId).catch(() => {});
		}
	}

	await submissions(ctx).delete(input.id);

	// Update form counter using count() to avoid race conditions
	if (existing.formId) {
		const form = await forms(ctx).get(existing.formId);
		if (form) {
			const count = await submissions(ctx).count({ formId: existing.formId });
			await forms(ctx).put(existing.formId, {
				...form,
				submissionCount: count,
			});
		}
	}

	return { deleted: true };
}

// ��── Export Submissions ──────────────────────────────────────────

export async function exportHandler(ctx: RouteContext<ExportInput>) {
	const input = ctx.input;

	// Load form definition
	let form: FormDefinition | null = null;
	const byId = await forms(ctx).get(input.formId);
	if (byId) {
		form = byId;
	} else {
		const bySlug = await forms(ctx).query({
			where: { slug: input.formId },
			limit: 1,
		});
		if (bySlug.items.length > 0) {
			form = bySlug.items[0]!.data;
		}
	}

	if (!form) {
		throw PluginRouteError.notFound("Form not found");
	}

	// Build where clause
	const where: Record<string, string | number | boolean | null | Record<string, string>> = {
		formId: input.formId,
	};
	if (input.status) where.status = input.status;
	if (input.from || input.to) {
		const range: Record<string, string> = {};
		if (input.from) range.gte = input.from;
		if (input.to) range.lte = input.to;
		where.createdAt = range;
	}

	// Collect all submissions (paginate through)
	const allItems: Array<{ id: string; data: Submission }> = [];
	let cursor: string | undefined;

	do {
		const batch = await submissions(ctx).query({
			where: where,
			orderBy: { createdAt: "desc" },
			limit: 100,
			cursor,
		});

		for (const item of batch.items) {
			allItems.push(item);
		}

		cursor = batch.cursor;
	} while (cursor);

	if (input.format === "json") {
		return {
			data: allItems.map((item) => item.data),
			count: allItems.length,
			contentType: "application/json",
		};
	}

	// CSV
	const csv = formatCsv(form, allItems);
	return {
		data: csv,
		count: allItems.length,
		contentType: "text/csv",
		filename: `${form.slug}-submissions-${new Date().toISOString().split("T")[0]}.csv`,
	};
}
