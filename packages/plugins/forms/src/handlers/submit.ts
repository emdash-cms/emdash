/**
 * Public form submission handler.
 *
 * This is the main entry point for form submissions from anonymous visitors.
 * Handles spam protection, validation, file uploads, notifications, and webhooks.
 */

import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";
import { ulid } from "ulidx";

import {
	createSubmissionDelivery,
	DELIVERY_CRON_NAME,
	DELIVERY_CRON_SCHEDULE,
	summarizeDelivery,
} from "../outbox.js";
import type { SubmitInput } from "../schemas.js";
import { verifyTurnstile } from "../turnstile.js";
import type { FormDefinition, Submission, SubmissionFile } from "../types.js";
import { getFormFields } from "../types.js";
import { validateSubmission } from "../validation.js";

/** Typed access to plugin storage collections */
function forms(ctx: RouteContext): StorageCollection<FormDefinition> {
	return ctx.storage.forms as StorageCollection<FormDefinition>;
}

function submissions(ctx: RouteContext): StorageCollection<Submission> {
	return ctx.storage.submissions as StorageCollection<Submission>;
}

export async function submitHandler(ctx: RouteContext<SubmitInput>) {
	const input = ctx.input;
	const submissionId = ulid();
	const receiptId = ulid();

	// 1. Load form definition (by ID first, then by slug)
	let formId = input.formId;
	let form = await forms(ctx).get(formId);
	if (!form) {
		const bySlug = await forms(ctx).query({
			where: { slug: input.formId },
			limit: 1,
		});
		if (bySlug.items.length > 0) {
			formId = bySlug.items[0]!.id;
			form = bySlug.items[0]!.data;
		}
	}
	if (!form) {
		throw PluginRouteError.notFound("Form not found");
	}

	if (form.status === "paused") {
		throw new PluginRouteError(
			"FORM_PAUSED",
			"This form is not currently accepting submissions",
			410,
		);
	}

	const settings = form.settings;

	// 2. Spam protection
	if (settings.spamProtection === "turnstile") {
		const token = input.data["cf-turnstile-response"];
		if (typeof token !== "string" || !token) {
			throw PluginRouteError.forbidden("Spam verification required");
		}

		const secretKey = await ctx.kv.get<string>("settings:turnstileSecretKey");
		if (!secretKey || !ctx.http) {
			throw PluginRouteError.internal("Turnstile is not configured");
		}

		const result = await verifyTurnstile(
			token,
			secretKey,
			ctx.http.fetch.bind(ctx.http),
			ctx.requestMeta.ip,
		);

		if (!result.success) {
			ctx.log.warn("Turnstile verification failed", {
				errorCodes: result.errorCodes,
			});
			throw PluginRouteError.forbidden("Spam verification failed. Please try again.");
		}
	}

	if (settings.spamProtection === "honeypot") {
		if (input.data._hp) {
			// Honeypot triggered — return success silently
			return {
				success: true,
				message: settings.confirmationMessage,
				submissionId,
				receiptId,
			};
		}
	}

	// 3. Validate submission data
	const allFields = getFormFields(form);
	const result = validateSubmission(allFields, input.data);

	if (!result.valid) {
		return { success: false, errors: result.errors };
	}

	// Existing active installations do not rerun plugin:activate on upgrade. Check
	// the durable scheduler before any upload or submission write so a scheduling
	// failure cannot leave an accepted submission without an outbox worker.
	if (!ctx.cron) {
		throw PluginRouteError.internal("Form delivery is temporarily unavailable");
	}
	try {
		const tasks = await ctx.cron.list();
		const deliveryTask = tasks.find((task) => task.name === DELIVERY_CRON_NAME);
		if (!deliveryTask || deliveryTask.schedule !== DELIVERY_CRON_SCHEDULE) {
			await ctx.cron.schedule(DELIVERY_CRON_NAME, {
				schedule: DELIVERY_CRON_SCHEDULE,
			});
		}
	} catch (error) {
		ctx.log.error("Failed to ensure Forms delivery cron", {
			error: String(error).slice(0, 500),
		});
		throw PluginRouteError.internal("Form delivery is temporarily unavailable");
	}

	// 4. Upload files
	const files: SubmissionFile[] = [];
	if (input.files && ctx.media && "upload" in ctx.media) {
		const mediaWithWrite = ctx.media as {
			upload(
				filename: string,
				contentType: string,
				bytes: ArrayBuffer,
			): Promise<{ mediaId: string; storageKey: string; url: string }>;
		};

		for (const field of allFields.filter((f) => f.type === "file")) {
			const fileData = input.files[field.name];
			if (!fileData) continue;

			// Validate file type
			if (field.validation?.accept) {
				const allowed = field.validation.accept.split(",").map((s) => s.trim().toLowerCase());
				const ext = `.${fileData.filename.split(".").pop()?.toLowerCase()}`;
				const typeMatch = allowed.some(
					(a) =>
						a === ext ||
						a === fileData.contentType ||
						fileData.contentType.startsWith(a.replace("/*", "/")),
				);
				if (!typeMatch) {
					throw PluginRouteError.badRequest(`File type not allowed for ${field.label}`);
				}
			}

			// Validate file size
			if (
				field.validation?.maxFileSize &&
				fileData.bytes.byteLength > field.validation.maxFileSize
			) {
				throw PluginRouteError.badRequest(
					`File too large for ${field.label}. Maximum: ${Math.round(field.validation.maxFileSize / 1024)} KB`,
				);
			}

			const uploaded = await mediaWithWrite.upload(
				fileData.filename,
				fileData.contentType,
				fileData.bytes,
			);

			files.push({
				fieldName: field.name,
				filename: fileData.filename,
				contentType: fileData.contentType,
				size: fileData.bytes.byteLength,
				mediaId: uploaded.mediaId,
			});
		}
	}

	// 5. Store submission
	const createdAt = new Date().toISOString();
	const delivery = createSubmissionDelivery({
		form,
		submissionId,
		receiptId,
		data: result.data,
		files: files.length > 0 ? files : undefined,
		createdAt,
	});
	const deliverySummary = summarizeDelivery(delivery);
	const submission: Submission = {
		formId,
		data: result.data,
		files: files.length > 0 ? files : undefined,
		status: "new",
		starred: false,
		createdAt,
		meta: {
			ip: ctx.requestMeta.ip,
			userAgent: ctx.requestMeta.userAgent,
			referer: ctx.requestMeta.referer,
			country: ctx.requestMeta.geo?.country ?? null,
		},
		delivery,
		receiptId,
		deliveryStatus: deliverySummary.status,
		deliveryNextAttemptAt: deliverySummary.nextAttemptAt,
	};

	await submissions(ctx).put(submissionId, submission);

	// 6. Update form counters (use count() to avoid race conditions
	// from concurrent submissions doing read-modify-write)
	const submissionCount = await submissions(ctx).count({ formId });
	await forms(ctx).put(formId, {
		...form,
		submissionCount,
		lastSubmissionAt: new Date().toISOString(),
	});

	// 7. Return after the complete delivery plan is durably stored with the submission.
	return {
		success: true,
		message: settings.confirmationMessage,
		redirect: settings.redirectUrl,
		submissionId,
		receiptId,
	};
}

// ─── Public Form Definition Endpoint ─────────────────────────────

export async function definitionHandler(
	ctx: RouteContext<import("../schemas.js").DefinitionInput>,
) {
	const { id } = ctx.input;

	// Look up by ID first, then by slug
	let form = await forms(ctx).get(id);

	if (!form) {
		const bySlug = await forms(ctx).query({
			where: { slug: id },
			limit: 1,
		});
		if (bySlug.items.length > 0) {
			form = bySlug.items[0]!.data;
		}
	}

	if (!form) {
		throw PluginRouteError.notFound("Form not found");
	}

	if (form.status !== "active") {
		throw new PluginRouteError("FORM_PAUSED", "This form is not currently available", 410);
	}

	// Include Turnstile site key if configured
	const turnstileSiteKey =
		form.settings.spamProtection === "turnstile"
			? await ctx.kv.get<string>("settings:turnstileSiteKey")
			: null;

	// Return only the settings needed for client rendering — never expose
	// admin emails, webhook URLs, or other internal configuration.
	return {
		name: form.name,
		slug: form.slug,
		pages: form.pages,
		settings: {
			spamProtection: form.settings.spamProtection,
			submitLabel: form.settings.submitLabel,
			nextLabel: form.settings.nextLabel,
			prevLabel: form.settings.prevLabel,
		},
		status: form.status,
		_turnstileSiteKey: turnstileSiteKey,
	};
}
