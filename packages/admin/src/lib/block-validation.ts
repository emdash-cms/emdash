import type { BlockFieldDefinition, BlockType } from "./api/schema.js";
import { isStoredBlockValue } from "./block-field-state.js";

/**
 * A value inside a block that the server would reject. Only rules the server
 * enforces the same way are checked, so the editor never holds back a save the
 * server would accept.
 */
export interface BlockValueIssue {
	blockKey: string;
	/** Position of the block in the field's value. */
	blockIndex: number;
	/** The field slug inside the block, followed by a repeater item index and sub-field slug. */
	path: string;
	/** Slug of the block field that holds `path`. */
	field: string;
	/** Label of the field or repeater sub-field at `path`. */
	label: string;
	code: "required" | "too_small" | "too_big" | "invalid_format" | "invalid_value" | "not_integer";
	origin?: "string" | "number" | "array";
	minimum?: number;
	maximum?: number;
	format?: "regex" | "url";
	pattern?: string;
	/** Index of the repeater item, for sub-field issues. */
	item?: number;
}

type IssueDetails = Pick<
	BlockValueIssue,
	"code" | "origin" | "minimum" | "maximum" | "format" | "pattern"
>;

interface FieldIssue extends IssueDetails {
	path: string;
	label: string;
	item?: number;
}

interface SubFieldDefinition {
	slug: string;
	label?: string;
	type?: string;
	required?: boolean;
	options?: unknown;
}

const STRING_FIELD_TYPES = new Set(["string", "text", "url"]);
const NUMBER_FIELD_TYPES = new Set(["number", "integer"]);
const SAFE_ABSOLUTE_URL = /^(https?:|mailto:|tel:)/i;
const SITE_RELATIVE_HREF = /^(\/(?![/\\])|#)/;
const URL_BASE = new URL("https://emdash.invalid/");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSubFieldDefinition(value: unknown): value is SubFieldDefinition {
	return isRecord(value) && typeof value.slug === "string";
}

function isMissing(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

function finiteNumber(validation: Record<string, unknown> | undefined, key: string) {
	const value = validation?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOptions(options: unknown): string[] {
	return Array.isArray(options)
		? options.filter((option): option is string => typeof option === "string")
		: [];
}

function matchesPattern(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern).test(value);
	} catch {
		return true;
	}
}

function containsHrefControl(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
	}
	return false;
}

function resolvesOnSite(value: string): boolean {
	try {
		return new URL(value, URL_BASE).origin === URL_BASE.origin;
	} catch {
		return false;
	}
}

/** The server's `isSafeHref`, which every `url` field value must pass. */
export function isSafeHref(url: string): boolean {
	if (containsHrefControl(url)) return false;
	if (SAFE_ABSOLUTE_URL.test(url)) return URL.canParse(url);
	return SITE_RELATIVE_HREF.test(url) && resolvesOnSite(url);
}

function stringIssues(
	type: string | undefined,
	validation: Record<string, unknown> | undefined,
	value: string,
): IssueDetails[] {
	const issues: IssueDetails[] = [];
	if (type === "url" && !isSafeHref(value)) {
		issues.push({ code: "invalid_format", format: "url" });
	}
	const minLength = finiteNumber(validation, "minLength");
	const maxLength = finiteNumber(validation, "maxLength");
	if (minLength !== undefined && value.length < minLength) {
		issues.push({ code: "too_small", origin: "string", minimum: minLength });
	}
	if (maxLength !== undefined && value.length > maxLength) {
		issues.push({ code: "too_big", origin: "string", maximum: maxLength });
	}
	const pattern = validation?.pattern;
	if (typeof pattern === "string" && pattern && !matchesPattern(pattern, value)) {
		issues.push({ code: "invalid_format", format: "regex", pattern });
	}
	return issues;
}

function numberIssues(
	type: string | undefined,
	validation: Record<string, unknown> | undefined,
	value: number,
): IssueDetails[] {
	const issues: IssueDetails[] = [];
	if (type === "integer" && !Number.isInteger(value)) issues.push({ code: "not_integer" });
	const min = finiteNumber(validation, "min");
	const max = finiteNumber(validation, "max");
	if (min !== undefined && value < min) {
		issues.push({ code: "too_small", origin: "number", minimum: min });
	}
	if (max !== undefined && value > max) {
		issues.push({ code: "too_big", origin: "number", maximum: max });
	}
	return issues;
}

function optionIssues(options: string[], value: unknown): IssueDetails[] {
	if (options.length === 0) return [];
	const values = Array.isArray(value) ? value : [value];
	return values.some((item) => typeof item === "string" && !options.includes(item))
		? [{ code: "invalid_value" }]
		: [];
}

function subFieldIssues(subField: SubFieldDefinition, value: unknown): IssueDetails[] {
	const options = subField.type === "select" ? stringOptions(subField.options) : [];
	if (typeof value === "string" && options.includes(value)) return [];
	if (subField.required && isMissing(value)) return [{ code: "required" }];
	if (value === undefined || value === null) return [];
	if (typeof value === "string" && STRING_FIELD_TYPES.has(subField.type ?? "")) {
		return stringIssues(subField.type, undefined, value);
	}
	if (typeof value === "number" && NUMBER_FIELD_TYPES.has(subField.type ?? "")) {
		return numberIssues(subField.type, undefined, value);
	}
	return optionIssues(options, value);
}

function repeaterIssues(field: BlockFieldDefinition, value: unknown[]): FieldIssue[] {
	const issues: FieldIssue[] = [];
	const minItems = finiteNumber(field.validation, "minItems");
	const maxItems = finiteNumber(field.validation, "maxItems");
	if (minItems !== undefined && value.length < minItems) {
		issues.push({
			path: field.slug,
			label: field.label,
			code: "too_small",
			origin: "array",
			minimum: minItems,
		});
	}
	if (maxItems !== undefined && value.length > maxItems) {
		issues.push({
			path: field.slug,
			label: field.label,
			code: "too_big",
			origin: "array",
			maximum: maxItems,
		});
	}
	const subFields = Array.isArray(field.validation?.subFields)
		? field.validation.subFields.filter(isSubFieldDefinition)
		: [];
	for (const [index, row] of value.entries()) {
		if (!isRecord(row)) continue;
		for (const subField of subFields) {
			for (const issue of subFieldIssues(subField, row[subField.slug])) {
				issues.push({
					...issue,
					path: `${field.slug}.${index}.${subField.slug}`,
					label: subField.label || subField.slug,
					item: index,
				});
			}
		}
	}
	return issues;
}

function fieldIssues(field: BlockFieldDefinition, value: unknown): FieldIssue[] {
	const at = (issues: IssueDetails[]) =>
		issues.map((issue) => ({ ...issue, path: field.slug, label: field.label }));
	if (value === undefined && field.defaultValue !== undefined) return [];
	if (field.required && isMissing(value)) return at([{ code: "required" }]);
	if (value === undefined || value === null) return [];
	if (STRING_FIELD_TYPES.has(field.type) && typeof value === "string") {
		return at(stringIssues(field.type, field.validation, value));
	}
	if (NUMBER_FIELD_TYPES.has(field.type) && typeof value === "number") {
		return at(numberIssues(field.type, field.validation, value));
	}
	if (field.type === "select" || field.type === "multiSelect") {
		return at(optionIssues(stringOptions(field.validation?.options), value));
	}
	if (field.type === "repeater" && Array.isArray(value)) return repeaterIssues(field, value);
	return [];
}

/**
 * Check each block in a blocks field value against its stored definition.
 * Blocks whose type or version is unavailable are left to the server.
 */
export function validateBlocks(
	value: unknown,
	blockTypes: readonly BlockType[],
): BlockValueIssue[] {
	if (!Array.isArray(value)) return [];
	const issues: BlockValueIssue[] = [];
	for (const [blockIndex, block] of value.entries()) {
		if (!isStoredBlockValue(block)) continue;
		const definition = blockTypes
			.find((blockType) => blockType.slug === block._type)
			?.versions.find((version) => version.version === block._version);
		if (!definition || definition.unsupportedTypes?.length) continue;
		for (const field of definition.fields) {
			for (const issue of fieldIssues(field, block[field.slug])) {
				issues.push({ ...issue, field: field.slug, blockKey: block._key, blockIndex });
			}
		}
	}
	return issues;
}

/** The id of the control for `issue`, matching the ids the content editor gives block fields. */
export function blockIssueElementId(fieldPath: string, issue: BlockValueIssue): string {
	return `field-${fieldPath}.${issue.blockKey}.${issue.path}`;
}
