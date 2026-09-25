/**
 * Zod schemas for route input validation.
 */

import { z } from "astro/zod";

/** Matches http(s) scheme at start of URL */
const HTTP_SCHEME_RE = /^https?:\/\//i;

/** Validates that a URL string uses http or https scheme. Rejects javascript:/data: URI XSS vectors. */
const httpUrl = z.url().refine((url) => HTTP_SCHEME_RE.test(url), "URL must use http or https");
const isoDateTime = z.iso.datetime().or(z.iso.datetime({ precision: -1 }));

// ─── Field Schemas ───────────────────────────────────────────────

const fieldOptionSchema = z.object({
	label: z.string().min(1),
	value: z.string().min(1),
});

const fieldValidationSchema = z
	.object({
		minLength: z.number().int().min(0).optional(),
		maxLength: z.number().int().min(1).optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		pattern: z.string().optional(),
		patternMessage: z.string().optional(),
		accept: z.string().optional(),
		maxFileSize: z.number().int().min(1).optional(),
	})
	.optional();

const fieldConditionSchema = z
	.object({
		field: z.string().min(1),
		op: z.enum(["eq", "neq", "filled", "empty"]),
		value: z.string().optional(),
	})
	.optional();

export const fieldTypeSchema = z.enum([
	"text",
	"email",
	"textarea",
	"number",
	"tel",
	"url",
	"date",
	"select",
	"radio",
	"checkbox",
	"checkbox-group",
	"file",
	"hidden",
]);

const formFieldSchema = z.object({
	id: z.string().min(1),
	type: fieldTypeSchema,
	label: z.string().min(1),
	name: z
		.string()
		.min(1)
		.regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "Invalid field name"),
	placeholder: z.string().optional(),
	helpText: z.string().optional(),
	required: z.boolean(),
	validation: fieldValidationSchema,
	options: z.array(fieldOptionSchema).optional(),
	defaultValue: z.string().optional(),
	width: z.enum(["full", "half"]).default("full"),
	condition: fieldConditionSchema,
});

const formPageSchema = z.object({
	title: z.string().optional(),
	fields: z.array(formFieldSchema).min(1, "Each page must have at least one field"),
});

// ─── Settings Schema ─────────────────────────────────────────────

const autoresponderSchema = z
	.object({
		subject: z.string().min(1),
		body: z.string().min(1),
	})
	.optional();

/**
 * The settings shape, declared once WITHOUT defaults so the update schema can reuse it.
 *
 * Zod's `.partial()` does not strip `.default()`: a key absent from the input is still filled with the
 * field's default. Applying `.partial()` to a defaulted schema therefore produces a parse result holding
 * values the caller never sent, and `formsUpdateHandler` merges that over the stored settings. Defaults
 * belong to create only.
 */
const formSettingsShape = {
	confirmationMessage: z.string().min(1),
	redirectUrl: httpUrl.optional().or(z.literal("")),
	notifyEmails: z.array(z.email()),
	digestEnabled: z.boolean(),
	digestHour: z.number().int().min(0).max(23),
	autoresponder: autoresponderSchema,
	webhookUrl: httpUrl.optional().or(z.literal("")),
	retentionDays: z.number().int().min(0),
	spamProtection: z.enum(["none", "honeypot", "turnstile"]),
	submitLabel: z.string().min(1),
	nextLabel: z.string().optional(),
	prevLabel: z.string().optional(),
};

/** Create: a missing setting takes its default. */
const formSettingsSchema = z.object({
	...formSettingsShape,
	confirmationMessage: formSettingsShape.confirmationMessage.default(
		"Thank you for your submission.",
	),
	notifyEmails: formSettingsShape.notifyEmails.default([]),
	digestEnabled: formSettingsShape.digestEnabled.default(false),
	digestHour: formSettingsShape.digestHour.default(9),
	retentionDays: formSettingsShape.retentionDays.default(0),
	spamProtection: formSettingsShape.spamProtection.default("honeypot"),
	submitLabel: formSettingsShape.submitLabel.default("Submit"),
});

/** Update: a missing setting stays missing, so the handler's merge keeps the stored value. */
const formSettingsUpdateSchema = z.object(formSettingsShape).partial();

// ─── Form CRUD Schemas ──────────────────────────────────────────

export const formCreateSchema = z.object({
	name: z.string().min(1).max(200),
	slug: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[a-z][a-z0-9-]*$/, "Slug must be lowercase alphanumeric with hyphens"),
	pages: z.array(formPageSchema).min(1),
	settings: formSettingsSchema,
});

export const formUpdateSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1).max(200).optional(),
	slug: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[a-z][a-z0-9-]*$/)
		.optional(),
	pages: z.array(formPageSchema).min(1).optional(),
	settings: formSettingsUpdateSchema.optional(),
	status: z.enum(["active", "paused"]).optional(),
});

export const formDeleteSchema = z.object({
	id: z.string().min(1),
	deleteSubmissions: z.boolean().default(true),
});

export const formDuplicateSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1).max(200).optional(),
	slug: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[a-z][a-z0-9-]*$/)
		.optional(),
});

export const definitionSchema = z.object({
	id: z.string().min(1),
});

export type DefinitionInput = z.infer<typeof definitionSchema>;

// ─── Submission Schemas ──────────────────────────────────────────

/** Upper bound for one uploaded file, applied even when the field sets no `maxFileSize`. */
export const MAX_SUBMISSION_FILE_BYTES = 10 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** File contents as base64, or as an array of byte values; either way parsed to bytes. */
const fileBytes = z
	.union([
		z
			.string()
			.max(Math.ceil(MAX_SUBMISSION_FILE_BYTES / 3) * 4, "File is too large")
			.regex(BASE64_RE, "File contents must be base64")
			.refine((b64) => b64.length % 4 === 0, "File contents must be base64")
			.transform(decodeBase64),
		z
			.array(z.number().int().min(0).max(255))
			.max(MAX_SUBMISSION_FILE_BYTES, "File is too large")
			.transform((values) => Uint8Array.from(values)),
	])
	.refine((bytes) => bytes.byteLength > 0, "File is empty")
	.refine((bytes) => bytes.byteLength <= MAX_SUBMISSION_FILE_BYTES, "File is too large");

export const submitSchema = z.object({
	formId: z.string().min(1),
	data: z.record(z.string(), z.unknown()),
	files: z
		.record(
			z.string(),
			z.object({
				filename: z.string(),
				contentType: z.string(),
				bytes: fileBytes,
			}),
		)
		.optional(),
});

export const submissionsListSchema = z.object({
	formId: z.string().min(1),
	status: z.enum(["new", "read", "archived"]).optional(),
	starred: z.boolean().optional(),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).default(50),
});

export const submissionGetSchema = z.object({
	id: z.string().min(1),
});

export const submissionUpdateSchema = z.object({
	id: z.string().min(1),
	status: z.enum(["new", "read", "archived"]).optional(),
	starred: z.boolean().optional(),
	notes: z.string().optional(),
});

export const submissionDeleteSchema = z.object({
	id: z.string().min(1),
});

export const exportSchema = z.object({
	formId: z.string().min(1),
	format: z.enum(["csv", "json"]).default("csv"),
	status: z.enum(["new", "read", "archived"]).optional(),
	from: isoDateTime.optional(),
	to: isoDateTime.optional(),
});

// ─── Type Exports ────────────────────────────────────────────────

export type FormCreateInput = z.infer<typeof formCreateSchema>;
export type FormUpdateInput = z.infer<typeof formUpdateSchema>;
export type FormDeleteInput = z.infer<typeof formDeleteSchema>;
export type FormDuplicateInput = z.infer<typeof formDuplicateSchema>;
export type SubmitInput = z.infer<typeof submitSchema>;
export type SubmissionsListInput = z.infer<typeof submissionsListSchema>;
export type SubmissionGetInput = z.infer<typeof submissionGetSchema>;
export type SubmissionUpdateInput = z.infer<typeof submissionUpdateSchema>;
export type SubmissionDeleteInput = z.infer<typeof submissionDeleteSchema>;
export type ExportInput = z.infer<typeof exportSchema>;
