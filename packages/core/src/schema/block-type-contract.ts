import {
	BLOCK_FIELD_TYPES,
	type BlockFieldDefinition,
	type BlockFieldType,
	type BlockTypeCompatibility,
	type BlockTypeDifference,
} from "./block-types.js";
import { SchemaError } from "./registry.js";
import { REPEATER_SUB_FIELD_TYPES, type RepeaterSubField } from "./types.js";

const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_+\-.]*\/[a-z0-9!#$&^_+\-.]*$/i;
const MAX_SLUG_LENGTH = 63;
const MAX_LABEL_LENGTH = 200;
const RESERVED_VALUE_KEYS: ReadonlySet<string> = new Set(["_type", "_version", "_key"]);
const BLOCK_FIELD_TYPE_SET: ReadonlySet<string> = new Set(BLOCK_FIELD_TYPES);
const REPEATER_TYPE_SET: ReadonlySet<string> = new Set(REPEATER_SUB_FIELD_TYPES);

const VALIDATION_KEYS: Record<BlockFieldType, ReadonlySet<string>> = {
	string: new Set(["minLength", "maxLength", "pattern"]),
	text: new Set(["minLength", "maxLength", "pattern"]),
	url: new Set(["minLength", "maxLength", "pattern"]),
	number: new Set(["min", "max"]),
	integer: new Set(["min", "max"]),
	boolean: new Set(),
	datetime: new Set(),
	select: new Set(["options"]),
	multiSelect: new Set(["options"]),
	portableText: new Set(),
	image: new Set(["allowedMimeTypes"]),
	file: new Set(["allowedMimeTypes"]),
	repeater: new Set(["subFields", "minItems", "maxItems"]),
};

function fail(path: string, message: string): never {
	throw new SchemaError(`${path}: ${message}`, "VALIDATION_ERROR", { path });
}

function assertSlug(slug: unknown, path: string): asserts slug is string {
	if (
		typeof slug !== "string" ||
		slug.length === 0 ||
		slug.length > MAX_SLUG_LENGTH ||
		!SLUG_PATTERN.test(slug)
	) {
		fail(
			path,
			"must start with a letter and contain only lowercase letters, numbers, and underscores",
		);
	}
}

function assertLabel(label: unknown, path: string): asserts label is string {
	if (typeof label !== "string" || label.trim().length === 0 || label.length > MAX_LABEL_LENGTH) {
		fail(path, `must contain between 1 and ${MAX_LABEL_LENGTH} characters`);
	}
}

function isJsonValue(value: unknown, seen: Set<object> = new Set()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) {
		const valid = value.every((entry) => isJsonValue(entry, seen));
		seen.delete(value);
		return valid;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		seen.delete(value);
		return false;
	}
	const valid = Object.values(value).every((entry) => isJsonValue(entry, seen));
	seen.delete(value);
	return valid;
}

function validateOptions(values: unknown, path: string): asserts values is string[] {
	if (!Array.isArray(values) || values.length === 0) fail(path, "must be a non-empty array");
	if (values.some((value) => typeof value !== "string" || value.length === 0)) {
		fail(path, "must contain non-empty strings");
	}
	if (new Set(values).size !== values.length) fail(path, "must not contain duplicates");
}

function validateRepeaterSubFields(
	value: unknown,
	path: string,
): asserts value is RepeaterSubField[] {
	if (!Array.isArray(value) || value.length === 0) fail(path, "must be a non-empty array");
	const slugs = new Set<string>();
	for (const [index, subField] of value.entries()) {
		const fieldPath = `${path}[${index}]`;
		if (!subField || typeof subField !== "object" || Array.isArray(subField)) {
			fail(fieldPath, "must be an object");
		}
		const slug = "slug" in subField ? subField.slug : undefined;
		assertSlug(slug, `${fieldPath}.slug`);
		if (RESERVED_VALUE_KEYS.has(slug)) fail(`${fieldPath}.slug`, `"${slug}" is reserved`);
		if (slugs.has(slug)) fail(`${fieldPath}.slug`, `duplicate slug "${slug}"`);
		slugs.add(slug);
		const label = "label" in subField ? subField.label : undefined;
		assertLabel(label, `${fieldPath}.label`);
		const type = "type" in subField ? subField.type : undefined;
		if (typeof type !== "string" || !REPEATER_TYPE_SET.has(type)) {
			fail(`${fieldPath}.type`, `unsupported repeater field type "${String(type)}"`);
		}
		const options = "options" in subField ? subField.options : undefined;
		if (type === "select") validateOptions(options, `${fieldPath}.options`);
		else if (options !== undefined)
			fail(`${fieldPath}.options`, `is not supported for type "${type}"`);
		const required = "required" in subField ? subField.required : undefined;
		if (required !== undefined && typeof required !== "boolean") {
			fail(`${fieldPath}.required`, "must be a boolean");
		}
	}
}

function validateValidation(field: BlockFieldDefinition, path: string): void {
	const validation = field.validation;
	if (validation === undefined) {
		if (field.type === "select" || field.type === "multiSelect") {
			fail(`${path}.validation.options`, `is required for type "${field.type}"`);
		}
		if (field.type === "repeater") fail(`${path}.validation.subFields`, "is required");
		return;
	}
	if (!validation || typeof validation !== "object" || Array.isArray(validation)) {
		fail(`${path}.validation`, "must be an object");
	}
	for (const key of Object.keys(validation)) {
		if (!VALIDATION_KEYS[field.type].has(key)) {
			fail(`${path}.validation.${key}`, `is not supported for type "${field.type}"`);
		}
	}

	for (const [minimum, maximum] of [
		["min", "max"],
		["minLength", "maxLength"],
		["minItems", "maxItems"],
	] as const) {
		const minimumValue = validation[minimum];
		const maximumValue = validation[maximum];
		if (
			minimumValue !== undefined &&
			(typeof minimumValue !== "number" || !Number.isFinite(minimumValue))
		) {
			fail(`${path}.validation.${minimum}`, "must be a finite number");
		}
		if (
			maximumValue !== undefined &&
			(typeof maximumValue !== "number" || !Number.isFinite(maximumValue))
		) {
			fail(`${path}.validation.${maximum}`, "must be a finite number");
		}
		if (
			typeof minimumValue === "number" &&
			typeof maximumValue === "number" &&
			minimumValue > maximumValue
		) {
			fail(`${path}.validation.${maximum}`, `must be greater than or equal to ${minimum}`);
		}
	}
	for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
		const value = validation[key];
		if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
			fail(`${path}.validation.${key}`, "must be a non-negative integer");
		}
	}
	if (validation.pattern !== undefined) {
		if (typeof validation.pattern !== "string")
			fail(`${path}.validation.pattern`, "must be a string");
		try {
			RegExp(validation.pattern);
		} catch {
			fail(`${path}.validation.pattern`, "must be a valid regular expression");
		}
	}
	if (field.type === "select" || field.type === "multiSelect") {
		validateOptions(validation.options, `${path}.validation.options`);
	}
	if (field.type === "repeater") {
		validateRepeaterSubFields(validation.subFields, `${path}.validation.subFields`);
	}
	if (validation.allowedMimeTypes !== undefined) {
		validateOptions(validation.allowedMimeTypes, `${path}.validation.allowedMimeTypes`);
		for (const mime of validation.allowedMimeTypes) {
			if (!MIME_PATTERN.test(mime))
				fail(`${path}.validation.allowedMimeTypes`, `invalid MIME type "${mime}"`);
		}
	}
}

export function validateBlockFields(
	fields: readonly BlockFieldDefinition[],
): BlockFieldDefinition[] {
	if (!Array.isArray(fields)) fail("fields", "must be an array");
	const slugs = new Set<string>();
	return fields.map((field, index) => {
		const path = `fields[${index}]`;
		if (!field || typeof field !== "object" || Array.isArray(field))
			fail(path, "must be an object");
		assertSlug(field.slug, `${path}.slug`);
		if (RESERVED_VALUE_KEYS.has(field.slug)) fail(`${path}.slug`, `"${field.slug}" is reserved`);
		if (slugs.has(field.slug)) fail(`${path}.slug`, `duplicate slug "${field.slug}"`);
		slugs.add(field.slug);
		assertLabel(field.label, `${path}.label`);
		if (typeof field.type !== "string" || !BLOCK_FIELD_TYPE_SET.has(field.type)) {
			fail(`${path}.type`, `unsupported block field type "${String(field.type)}"`);
		}
		if (field.required !== undefined && typeof field.required !== "boolean") {
			fail(`${path}.required`, "must be a boolean");
		}
		if (field.defaultValue !== undefined && !isJsonValue(field.defaultValue)) {
			fail(`${path}.defaultValue`, "must be a JSON value");
		}
		if (field.options !== undefined) {
			if (field.type !== "image")
				fail(`${path}.options`, `is not supported for type "${field.type}"`);
			for (const key of Object.keys(field.options)) {
				if (key !== "darkVariant") fail(`${path}.options.${key}`, "is not a supported option");
			}
			if (
				field.options.darkVariant !== undefined &&
				typeof field.options.darkVariant !== "boolean"
			) {
				fail(`${path}.options.darkVariant`, "must be a boolean");
			}
		}
		validateValidation(field, path);
		return field;
	});
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (entry !== undefined) result[key] = canonicalize(entry);
	}
	return result;
}

function contractFields(fields: readonly BlockFieldDefinition[]): unknown[] {
	return fields.map((field) => ({
		slug: field.slug,
		type: field.type,
		required: field.required ?? false,
		...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
		...(field.validation !== undefined ? { validation: field.validation } : {}),
		...(field.options !== undefined ? { options: field.options } : {}),
	}));
}

export function canonicalBlockFields(fields: readonly BlockFieldDefinition[]): string {
	return JSON.stringify(canonicalize(contractFields(fields)));
}

export async function fingerprintBlockFields(
	fields: readonly BlockFieldDefinition[],
): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalBlockFields(fields));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
	return `block-type:v1:sha256:${hex}`;
}

function equal(a: unknown, b: unknown): boolean {
	return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function difference(
	differences: BlockTypeDifference[],
	path: string,
	change: string,
	compatibility: "compatible" | "breaking",
): void {
	differences.push({ path, change, compatibility });
}

function compareLowerBound(
	differences: BlockTypeDifference[],
	path: string,
	key: "min" | "minLength" | "minItems",
	before: number | undefined,
	after: number | undefined,
): void {
	if (before === after) return;
	const compatible = after === undefined || (before !== undefined && after <= before);
	difference(
		differences,
		`${path}.validation.${key}`,
		"changed",
		compatible ? "compatible" : "breaking",
	);
}

function compareUpperBound(
	differences: BlockTypeDifference[],
	path: string,
	key: "max" | "maxLength" | "maxItems",
	before: number | undefined,
	after: number | undefined,
): void {
	if (before === after) return;
	const compatible = after === undefined || (before !== undefined && after >= before);
	difference(
		differences,
		`${path}.validation.${key}`,
		"changed",
		compatible ? "compatible" : "breaking",
	);
}

function compareSet(
	differences: BlockTypeDifference[],
	path: string,
	before: readonly string[] | undefined,
	after: readonly string[] | undefined,
): void {
	if (equal(before, after)) return;
	if (after === undefined) {
		difference(differences, path, "constraint removed", "compatible");
		return;
	}
	if (before === undefined) {
		difference(differences, path, "constraint added", "breaking");
		return;
	}
	const afterSet = new Set(after);
	const removed = before.some((value) => !afterSet.has(value));
	difference(differences, path, "allowed values changed", removed ? "breaking" : "compatible");
}

function repeaterFields(fields: readonly RepeaterSubField[] | undefined): BlockFieldDefinition[] {
	return (fields ?? []).map((field) => ({
		slug: field.slug,
		label: field.label,
		type: field.type,
		required: field.required,
		...(field.options ? { validation: { options: field.options } } : {}),
	}));
}

function compareValidation(
	differences: BlockTypeDifference[],
	path: string,
	before: BlockFieldDefinition,
	after: BlockFieldDefinition,
): void {
	const beforeValidation = before.validation;
	const afterValidation = after.validation;
	compareLowerBound(differences, path, "min", beforeValidation?.min, afterValidation?.min);
	compareUpperBound(differences, path, "max", beforeValidation?.max, afterValidation?.max);
	compareLowerBound(
		differences,
		path,
		"minLength",
		beforeValidation?.minLength,
		afterValidation?.minLength,
	);
	compareUpperBound(
		differences,
		path,
		"maxLength",
		beforeValidation?.maxLength,
		afterValidation?.maxLength,
	);
	compareLowerBound(
		differences,
		path,
		"minItems",
		beforeValidation?.minItems,
		afterValidation?.minItems,
	);
	compareUpperBound(
		differences,
		path,
		"maxItems",
		beforeValidation?.maxItems,
		afterValidation?.maxItems,
	);
	if (beforeValidation?.pattern !== afterValidation?.pattern) {
		const compatible = afterValidation?.pattern === undefined;
		difference(
			differences,
			`${path}.validation.pattern`,
			"changed",
			compatible ? "compatible" : "breaking",
		);
	}
	compareSet(
		differences,
		`${path}.validation.options`,
		beforeValidation?.options,
		afterValidation?.options,
	);
	compareSet(
		differences,
		`${path}.validation.allowedMimeTypes`,
		beforeValidation?.allowedMimeTypes,
		afterValidation?.allowedMimeTypes,
	);
	if (before.type === "repeater" && after.type === "repeater") {
		compareFields(
			differences,
			`${path}.validation.subFields`,
			repeaterFields(beforeValidation?.subFields),
			repeaterFields(afterValidation?.subFields),
		);
	}
}

function compareFields(
	differences: BlockTypeDifference[],
	path: string,
	before: readonly BlockFieldDefinition[],
	after: readonly BlockFieldDefinition[],
): void {
	const beforeBySlug = new Map(before.map((field) => [field.slug, field]));
	const afterBySlug = new Map(after.map((field) => [field.slug, field]));
	for (const field of before) {
		if (!afterBySlug.has(field.slug)) {
			difference(differences, `${path}.${field.slug}`, "field removed", "breaking");
		}
	}
	for (const field of after) {
		const previous = beforeBySlug.get(field.slug);
		const fieldPath = `${path}.${field.slug}`;
		if (!previous) {
			difference(differences, fieldPath, "field added", field.required ? "breaking" : "compatible");
			continue;
		}
		if (previous.type !== field.type) {
			difference(differences, `${fieldPath}.type`, "type changed", "breaking");
			continue;
		}
		if ((previous.required ?? false) !== (field.required ?? false)) {
			difference(
				differences,
				`${fieldPath}.required`,
				"required changed",
				field.required ? "breaking" : "compatible",
			);
		}
		if (!equal(previous.defaultValue, field.defaultValue)) {
			difference(differences, `${fieldPath}.defaultValue`, "default changed", "compatible");
		}
		compareValidation(differences, fieldPath, previous, field);
		if ((previous.options?.darkVariant ?? false) !== (field.options?.darkVariant ?? false)) {
			difference(
				differences,
				`${fieldPath}.options.darkVariant`,
				"dark variant changed",
				field.options?.darkVariant ? "compatible" : "breaking",
			);
		}
	}
}

export function compareBlockFields(
	before: readonly BlockFieldDefinition[],
	after: readonly BlockFieldDefinition[],
): BlockTypeCompatibility {
	const differences: BlockTypeDifference[] = [];
	compareFields(differences, "fields", before, after);
	return {
		compatible: differences.every((entry) => entry.compatibility === "compatible"),
		differences,
	};
}
