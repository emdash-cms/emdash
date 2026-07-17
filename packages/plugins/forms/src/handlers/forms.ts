/**
 * Form CRUD route handlers.
 *
 * Admin-only routes for managing form definitions.
 */

import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";
import { ulid } from "ulidx";

import { validateContentMapping } from "../content-mapping.js";
import type {
	FormCreateInput,
	FormDeleteInput,
	FormDuplicateInput,
	FormUpdateInput,
} from "../schemas.js";
import type { FormDefinition, FormSettings } from "../types.js";

/** Typed access to plugin storage collections */
function forms(ctx: RouteContext): StorageCollection<FormDefinition> {
	return ctx.storage.forms as StorageCollection<FormDefinition>;
}

function submissions(ctx: RouteContext): StorageCollection {
	return ctx.storage.submissions as StorageCollection;
}

// ─── List Forms ──────────────────────────────────────────────────

export async function formsListHandler(ctx: RouteContext) {
	const result = await forms(ctx).query({
		orderBy: { createdAt: "desc" },
		limit: 100,
	});

	return {
		items: result.items.map((item) => ({ id: item.id, ...item.data })),
		hasMore: result.hasMore,
		cursor: result.cursor,
	};
}

// ─── Create Form ─────────────────────────────────────────────────

export async function formsCreateHandler(ctx: RouteContext<FormCreateInput>) {
	const input = ctx.input;

	// Check slug uniqueness
	const existing = await forms(ctx).query({
		where: { slug: input.slug },
		limit: 1,
	});
	if (existing.items.length > 0) {
		throw PluginRouteError.conflict(`A form with slug "${input.slug}" already exists`);
	}

	// Validate field names are unique across all pages
	validateFieldNames(input.pages);

	// Validate the content mapping against the target collection at save
	// time — not only at submit time — so misconfigurations surface to the
	// editor immediately.
	if (input.settings.contentMapping) {
		await validateContentMapping(ctx, input.settings.contentMapping, input.pages);
	}

	const now = new Date().toISOString();
	const id = ulid();
	const form: FormDefinition = {
		name: input.name,
		slug: input.slug,
		pages: input.pages,
		settings: {
			confirmationMessage: input.settings.confirmationMessage ?? "Thank you for your submission.",
			redirectUrl: input.settings.redirectUrl || undefined,
			notifyEmails: input.settings.notifyEmails ?? [],
			digestEnabled: input.settings.digestEnabled ?? false,
			digestHour: input.settings.digestHour ?? 9,
			autoresponder: input.settings.autoresponder,
			webhookUrl: input.settings.webhookUrl || undefined,
			retentionDays: input.settings.retentionDays ?? 0,
			spamProtection: input.settings.spamProtection ?? "honeypot",
			submitLabel: input.settings.submitLabel ?? "Submit",
			nextLabel: input.settings.nextLabel,
			prevLabel: input.settings.prevLabel,
			contentMapping: input.settings.contentMapping ?? undefined,
		},
		status: "active",
		submissionCount: 0,
		lastSubmissionAt: null,
		createdAt: now,
		updatedAt: now,
	};

	await forms(ctx).put(id, form);

	// Schedule digest cron if enabled
	if (form.settings.digestEnabled && ctx.cron) {
		await ctx.cron.schedule(`digest:${id}`, {
			schedule: `0 ${form.settings.digestHour} * * *`,
		});
	}

	return { id, ...form };
}

// ─── Update Form ─────────────────────────────────────────────────

export async function formsUpdateHandler(ctx: RouteContext<FormUpdateInput>) {
	const input = ctx.input;

	const existing = await forms(ctx).get(input.id);
	if (!existing) {
		throw PluginRouteError.notFound("Form not found");
	}

	// Check slug uniqueness if changing
	if (input.slug && input.slug !== existing.slug) {
		const slugCheck = await forms(ctx).query({
			where: { slug: input.slug },
			limit: 1,
		});
		if (slugCheck.items.length > 0) {
			throw PluginRouteError.conflict(`A form with slug "${input.slug}" already exists`);
		}
	}

	if (input.pages) {
		validateFieldNames(input.pages);
	}

	const updated: FormDefinition = {
		...existing,
		name: input.name ?? existing.name,
		slug: input.slug ?? existing.slug,
		pages: input.pages ?? existing.pages,
		settings: mergeSettings(existing.settings, input.settings),
		status: input.status ?? existing.status,
		updatedAt: new Date().toISOString(),
	};

	// Clean up empty strings
	if (updated.settings.redirectUrl === "") updated.settings.redirectUrl = undefined;
	if (updated.settings.webhookUrl === "") updated.settings.webhookUrl = undefined;

	// Validate the merged result so page edits that break an existing
	// mapping (e.g. renaming a mapped form field) are caught at save time.
	if (updated.settings.contentMapping) {
		await validateContentMapping(ctx, updated.settings.contentMapping, updated.pages);
	}

	await forms(ctx).put(input.id, updated);

	// Update digest cron if settings changed
	if (ctx.cron) {
		if (updated.settings.digestEnabled && !existing.settings.digestEnabled) {
			await ctx.cron.schedule(`digest:${input.id}`, {
				schedule: `0 ${updated.settings.digestHour} * * *`,
			});
		} else if (!updated.settings.digestEnabled && existing.settings.digestEnabled) {
			await ctx.cron.cancel(`digest:${input.id}`);
		} else if (
			updated.settings.digestEnabled &&
			updated.settings.digestHour !== existing.settings.digestHour
		) {
			await ctx.cron.schedule(`digest:${input.id}`, {
				schedule: `0 ${updated.settings.digestHour} * * *`,
			});
		}
	}

	return { id: input.id, ...updated };
}

// ─── Delete Form ─────────────────────────────────────────────────

export async function formsDeleteHandler(ctx: RouteContext<FormDeleteInput>) {
	const input = ctx.input;

	const existing = await forms(ctx).get(input.id);
	if (!existing) {
		throw PluginRouteError.notFound("Form not found");
	}

	// Delete associated submissions if requested
	if (input.deleteSubmissions) {
		await deleteFormSubmissions(input.id, ctx);
	}

	// Cancel digest cron
	if (ctx.cron) {
		await ctx.cron.cancel(`digest:${input.id}`).catch(() => {});
	}

	await forms(ctx).delete(input.id);

	return { deleted: true };
}

// ─── Duplicate Form ──────────────────────────────────────────────

export async function formsDuplicateHandler(ctx: RouteContext<FormDuplicateInput>) {
	const input = ctx.input;

	const existing = await forms(ctx).get(input.id);
	if (!existing) {
		throw PluginRouteError.notFound("Form not found");
	}

	const newSlug = input.slug ?? `${existing.slug}-copy`;
	const newName = input.name ?? `${existing.name} (Copy)`;

	// Check slug uniqueness
	const slugCheck = await forms(ctx).query({
		where: { slug: newSlug },
		limit: 1,
	});
	if (slugCheck.items.length > 0) {
		throw PluginRouteError.conflict(`A form with slug "${newSlug}" already exists`);
	}

	const now = new Date().toISOString();
	const id = ulid();
	const duplicate: FormDefinition = {
		...existing,
		name: newName,
		slug: newSlug,
		submissionCount: 0,
		lastSubmissionAt: null,
		createdAt: now,
		updatedAt: now,
	};

	await forms(ctx).put(id, duplicate);

	return { id, ...duplicate };
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Merge a partial settings update into existing settings. `contentMapping`
 * accepts an explicit `null` to clear the mapping (undefined keeps it).
 */
function mergeSettings(existing: FormSettings, input: FormUpdateInput["settings"]): FormSettings {
	if (!input) return existing;
	const { contentMapping, ...rest } = input;
	const merged: FormSettings = { ...existing, ...rest };
	if (contentMapping !== undefined) {
		merged.contentMapping = contentMapping ?? undefined;
	}
	return merged;
}

function validateFieldNames(pages: Array<{ fields: Array<{ name: string }> }>) {
	const names = new Set<string>();
	for (const page of pages) {
		for (const field of page.fields) {
			if (names.has(field.name)) {
				throw PluginRouteError.badRequest(`Duplicate field name "${field.name}" across form pages`);
			}
			names.add(field.name);
		}
	}
}

/** Delete all submissions for a form, including media files */
async function deleteFormSubmissions(formId: string, ctx: RouteContext) {
	let cursor: string | undefined;
	do {
		const batch = await submissions(ctx).query({
			where: { formId },
			limit: 100,
			cursor,
		});

		// Delete associated media files
		if (ctx.media && "delete" in ctx.media) {
			const mediaWithDelete = ctx.media as { delete(id: string): Promise<boolean> };
			for (const item of batch.items) {
				const sub = item.data as { files?: Array<{ mediaId: string }> };
				if (sub.files) {
					for (const file of sub.files) {
						await mediaWithDelete.delete(file.mediaId).catch(() => {});
					}
				}
			}
		}

		const ids = batch.items.map((item) => item.id);
		if (ids.length > 0) {
			await submissions(ctx).deleteMany(ids);
		}

		cursor = batch.cursor;
	} while (cursor);
}
