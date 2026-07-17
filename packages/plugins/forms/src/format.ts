/**
 * Formatting utilities for email notifications and webhook payloads.
 */

import type { FormDefinition, Submission, SubmissionFile } from "./types.js";
import { getFormFields } from "./types.js";

const CSV_ESCAPE_RE = /[,"\n]/;
const DOUBLE_QUOTE_RE = /"/g;
const CSV_FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Format a submission as plain text for email notifications.
 */
export function formatSubmissionText(
	form: FormDefinition,
	data: Record<string, unknown>,
	files?: SubmissionFile[],
): string {
	const fields = getFormFields(form);
	const lines: string[] = [`New submission for "${form.name}"`, ""];

	for (const field of fields) {
		if (field.type === "hidden") continue;
		const value = data[field.name];
		if (value === undefined || value === null || value === "") continue;

		// eslint-disable-next-line typescript/no-base-to-string -- form field value is a scalar at runtime
		const display = Array.isArray(value) ? (value as string[]).join(", ") : String(value);
		lines.push(`${field.label}: ${display}`);
	}

	if (files && files.length > 0) {
		lines.push("", "Attached files:");
		for (const file of files) {
			lines.push(`  - ${file.filename} (${formatBytes(file.size)})`);
		}
	}

	lines.push("", `Submitted at: ${new Date().toISOString()}`);
	return lines.join("\n");
}

/**
 * Format a digest email summarizing submissions over a period.
 */
export function formatDigestText(
	form: FormDefinition,
	formId: string,
	submissions: Submission[],
	siteUrl: string,
): string {
	const lines: string[] = [
		`Daily digest for "${form.name}"`,
		"",
		`${submissions.length} new submission${submissions.length === 1 ? "" : "s"} since last digest.`,
		"",
	];

	for (const sub of submissions.slice(0, 10)) {
		const preview = getSubmissionPreview(form, sub);
		lines.push(`  - ${sub.createdAt}: ${preview}`);
	}

	if (submissions.length > 10) {
		lines.push(`  ... and ${submissions.length - 10} more`);
	}

	lines.push(
		"",
		`View all submissions: ${siteUrl}/_emdash/admin/plugins/emdash-forms/submissions?formId=${encodeURIComponent(formId)}`,
	);
	return lines.join("\n");
}

/**
 * Format a webhook payload for a new submission.
 */
export function formatWebhookPayload(
	form: FormDefinition,
	submissionId: string,
	data: Record<string, unknown>,
	files?: SubmissionFile[],
): Record<string, unknown> {
	return {
		event: "form.submission",
		formId: form.slug,
		formName: form.name,
		submissionId,
		data,
		files: files?.map((f) => ({
			fieldName: f.fieldName,
			filename: f.filename,
			contentType: f.contentType,
			size: f.size,
			mediaId: f.mediaId,
		})),
		submittedAt: new Date().toISOString(),
	};
}

/**
 * Format submissions as CSV.
 */
export function formatCsv(
	form: FormDefinition,
	items: Array<{ id: string; data: Submission }>,
): string {
	const fields = getFormFields(form).filter((f) => f.type !== "hidden");
	const headers = ["ID", "Submitted At", "Status", ...fields.map((f) => f.label)];

	const rows = items.map(({ id, data: sub }) => {
		const values = [id, sub.createdAt, sub.status];
		for (const field of fields) {
			const v = sub.data[field.name];
			if (field.type === "file") {
				const file = sub.files?.find((f) => f.fieldName === field.name);
				values.push(file ? file.filename : "");
			} else if (Array.isArray(v)) {
				values.push(v.join("; "));
			} else {
				// eslint-disable-next-line typescript/no-base-to-string -- form field value is a scalar at runtime
				values.push(v === undefined || v === null ? "" : String(v));
			}
		}
		return values;
	});

	return [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
}

function escapeCsv(value: string): string {
	// Neutralize formula triggers to prevent CSV injection in spreadsheet apps
	if (value.length > 0 && CSV_FORMULA_TRIGGERS.has(value.charAt(0))) {
		value = "'" + value;
	}
	if (CSV_ESCAPE_RE.test(value)) {
		return `"${value.replace(DOUBLE_QUOTE_RE, '""')}"`;
	}
	return value;
}

function getSubmissionPreview(form: FormDefinition, sub: Submission): string {
	const fields = getFormFields(form).filter((f) => f.type !== "hidden" && f.type !== "file");
	const previews: string[] = [];
	for (const field of fields.slice(0, 3)) {
		const v = sub.data[field.name];
		if (v !== undefined && v !== null && v !== "") {
			// eslint-disable-next-line typescript/no-base-to-string -- form field value is a scalar at runtime
			const str = String(v);
			previews.push(str.length > 50 ? `${str.slice(0, 47)}...` : str);
		}
	}
	return previews.join(" | ") || "(empty)";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
