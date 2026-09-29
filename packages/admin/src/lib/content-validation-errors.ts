import { i18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";

import { ApiResponseError, type AdminManifest } from "./api/client.js";
import { getFieldLabel } from "./field-label.js";

type ManifestFields = AdminManifest["collections"][string]["fields"];

interface ContentValidationIssue {
	path: string;
	code: string;
	origin?: unknown;
	minimum?: unknown;
	maximum?: unknown;
	format?: unknown;
}

function isContentValidationIssue(value: unknown): value is ContentValidationIssue {
	return (
		typeof value === "object" &&
		value !== null &&
		"path" in value &&
		typeof value.path === "string" &&
		"code" in value &&
		typeof value.code === "string"
	);
}

function isLabeledSubField(value: unknown): value is { slug: string; label: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"slug" in value &&
		typeof value.slug === "string" &&
		"label" in value &&
		typeof value.label === "string"
	);
}

function subFieldLabel(field: ManifestFields[string], slug: string): string | undefined {
	const subFields: unknown = field.validation?.subFields;
	if (!Array.isArray(subFields)) return undefined;
	const match: unknown = subFields.find(
		(subField: unknown) => isLabeledSubField(subField) && subField.slug === slug,
	);
	return isLabeledSubField(match) && match.label ? match.label : undefined;
}

function fieldName(path: string, fields: ManifestFields): string {
	const [slug = path, row, subSlug] = path.split(".");
	const field = fields[slug];
	if (!field) return slug;
	const label = getFieldLabel(slug, field);
	const position = Number(row) + 1;
	if (field.kind === "repeater" && subSlug && Number.isInteger(position)) {
		const subLabel = subFieldLabel(field, subSlug);
		if (subLabel) return i18n._(msg`${subLabel} (${label}, item ${position})`);
	}
	return label;
}

function describeIssue(issue: ContentValidationIssue, name: string): string {
	const minimum = typeof issue.minimum === "number" ? issue.minimum : undefined;
	const maximum = typeof issue.maximum === "number" ? issue.maximum : undefined;
	switch (issue.code) {
		case "required":
			return i18n._(msg`${name} is required.`);
		case "unknown_field":
			return i18n._(msg`${name} is not a field in this collection.`);
		case "reference_not_found":
			return i18n._(msg`${name} links to an entry that does not exist or is in the trash.`);
		case "invalid_value":
			return i18n._(msg`${name} has a value that is not one of its options.`);
		case "invalid_format":
			if (issue.format === "url") return i18n._(msg`${name} must be a valid URL.`);
			if (issue.format === "regex") return i18n._(msg`${name} does not match the required format.`);
			break;
		case "too_small":
			if (minimum === undefined) break;
			if (issue.origin === "string") {
				return plural(minimum, {
					one: `${name} needs at least # character.`,
					other: `${name} needs at least # characters.`,
				});
			}
			if (issue.origin === "array") {
				return plural(minimum, {
					one: `${name} needs at least # item.`,
					other: `${name} needs at least # items.`,
				});
			}
			if (issue.origin === "number") {
				const bound = i18n.number(minimum);
				return i18n._(msg`${name} must be at least ${bound}.`);
			}
			break;
		case "too_big":
			if (maximum === undefined) break;
			if (issue.origin === "string") {
				return plural(maximum, {
					one: `${name} can have at most # character.`,
					other: `${name} can have at most # characters.`,
				});
			}
			if (issue.origin === "array") {
				return plural(maximum, {
					one: `${name} can have at most # item.`,
					other: `${name} can have at most # items.`,
				});
			}
			if (issue.origin === "number") {
				const bound = i18n.number(maximum);
				return i18n._(msg`${name} must be at most ${bound}.`);
			}
			break;
	}
	return i18n._(msg`${name} has an invalid value.`);
}

/**
 * Word a rejected content save for the editor, naming each field by the label
 * the editor shows. Returns undefined for any error that does not carry the
 * content validator's per-field issues, so the caller keeps the server message.
 */
export function describeContentValidationError(
	error: unknown,
	fields: ManifestFields,
): string | undefined {
	if (!(error instanceof ApiResponseError) || error.code !== "VALIDATION_ERROR") return undefined;
	const issues = error.details?.issues;
	if (!Array.isArray(issues) || issues.length === 0) return undefined;
	if (!issues.every(isContentValidationIssue)) return undefined;

	const requiredPaths = new Set(
		issues.filter((issue) => issue.code === "required").map((issue) => issue.path),
	);
	const sentences = new Set<string>();
	for (const issue of issues) {
		if (issue.code !== "required" && requiredPaths.has(issue.path)) continue;
		sentences.add(describeIssue(issue, fieldName(issue.path, fields)));
	}
	return [...sentences].join(" ");
}
