/**
 * Core types for the forms plugin.
 *
 * These define the data model stored in plugin storage.
 */

// ─── Form Definitions ────────────────────────────────────────────

export interface FormDefinition {
	name: string;
	slug: string;
	pages: FormPage[];
	settings: FormSettings;
	status: "active" | "paused";
	submissionCount: number;
	lastSubmissionAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface FormPage {
	/** Page title shown in multi-page progress indicator. Optional for single-page forms. */
	title?: string;
	fields: FormField[];
}

export interface FormSettings {
	/** Message shown after successful submission */
	confirmationMessage: string;
	/** Redirect URL after submission (overrides confirmation message) */
	redirectUrl?: string;
	/** Email addresses for submission notifications */
	notifyEmails: string[];
	/** Enable daily digest instead of per-submission notifications */
	digestEnabled: boolean;
	/** Hour (0-23) to send digest, in site timezone */
	digestHour: number;
	/** Autoresponder email sent to the submitter */
	autoresponder?: {
		subject: string;
		body: string;
	};
	/** Webhook URL for submission notifications */
	webhookUrl?: string;
	/** Days to retain submissions (0 = forever) */
	retentionDays: number;
	/** Spam protection strategy */
	spamProtection: "none" | "honeypot" | "turnstile";
	/** Submit button text */
	submitLabel: string;
	/** Label for Next button on multi-page forms */
	nextLabel?: string;
	/** Label for Previous button on multi-page forms */
	prevLabel?: string;
	/** Create a draft content entry from each successful submission */
	contentMapping?: ContentMapping;
}

// ─── Content Mapping ─────────────────────────────────────────────

/**
 * Maps form submissions to content entries.
 *
 * When configured, each successful submission also creates a draft entry
 * in the target collection. The submission is always stored in the forms
 * inbox regardless — content creation is additive and a create failure
 * never loses the submission or fails the submit request.
 */
export interface ContentMapping {
	/** Target collection slug, e.g. "events" */
	collection: string;
	/** Form field name → target collection field (optionally with a transform) */
	fieldMappings: Record<string, string | ContentFieldMapping>;
	/** Form field whose value derives the entry slug */
	slugFrom?: string;
	/** Constant fields merged into every created entry, e.g. { source: "form" } */
	metadata?: Record<string, unknown>;
}

export interface ContentFieldMapping {
	/** Target collection field slug */
	field: string;
	/** Coerce the submitted value before writing it to the entry */
	transform?: ContentMappingTransform;
}

export type ContentMappingTransform = "portableText" | "string" | "number" | "date";

// ─── Form Fields ─────────────────────────────────────────────────

export interface FormField {
	id: string;
	type: FieldType;
	label: string;
	/** HTML input name, unique per form */
	name: string;
	placeholder?: string;
	helpText?: string;
	required: boolean;
	validation?: FieldValidation;
	/** For select, radio, checkbox-group */
	options?: FieldOption[];
	defaultValue?: string;
	/** Layout hint */
	width: "full" | "half";
	/** Conditional visibility */
	condition?: FieldCondition;
}

export type FieldType =
	| "text"
	| "email"
	| "textarea"
	| "number"
	| "tel"
	| "url"
	| "date"
	| "select"
	| "radio"
	| "checkbox"
	| "checkbox-group"
	| "file"
	| "hidden";

export interface FieldValidation {
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	/** Regex pattern */
	pattern?: string;
	/** Error message for pattern mismatch */
	patternMessage?: string;
	/** File types, e.g. ".pdf,.doc" */
	accept?: string;
	/** Max file size in bytes */
	maxFileSize?: number;
}

export interface FieldOption {
	label: string;
	value: string;
}

export interface FieldCondition {
	/** Name of the controlling field */
	field: string;
	op: "eq" | "neq" | "filled" | "empty";
	value?: string;
}

// ─── Submissions ─────────────────────────────────────────────────

export interface Submission {
	formId: string;
	data: Record<string, unknown>;
	files?: SubmissionFile[];
	status: "new" | "read" | "archived";
	starred: boolean;
	notes?: string;
	createdAt: string;
	meta: SubmissionMeta;
}

export interface SubmissionFile {
	fieldName: string;
	filename: string;
	contentType: string;
	size: number;
	/** Reference to media library item */
	mediaId: string;
}

export interface SubmissionMeta {
	ip: string | null;
	userAgent: string | null;
	referer: string | null;
	country: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Get all fields across all pages */
export function getFormFields(form: FormDefinition): FormField[] {
	return form.pages.flatMap((p) => p.fields);
}

/** Check if a form has multiple pages */
export function isMultiPage(form: FormDefinition): boolean {
	return form.pages.length > 1;
}

/** Check if a form has any file fields */
export function hasFileFields(form: FormDefinition): boolean {
	return getFormFields(form).some((f) => f.type === "file");
}
