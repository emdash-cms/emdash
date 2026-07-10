/**
 * Server-side submission validation.
 *
 * Validates submitted data against the form's field definitions.
 * These rules mirror what the client-side script checks, but server
 * validation is authoritative — never trust the client.
 */

import type { FieldType, FormField } from "./types.js";

export interface ValidationError {
	field: string;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
	/** Sanitized/coerced values */
	data: Record<string, unknown>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/;
const TEL_RE = /^[+\d][\d\s()-]*$/;

/**
 * Validate submission data against form field definitions.
 *
 * Returns sanitized data with proper type coercion and all validation
 * errors. Conditionally hidden fields are excluded from validation
 * if their condition is not met.
 */
export function validateSubmission(
	fields: FormField[],
	data: Record<string, unknown>,
): ValidationResult {
	const errors: ValidationError[] = [];
	const validated: Record<string, unknown> = {};

	for (const field of fields) {
		// Skip conditionally hidden fields
		if (field.condition && !evaluateCondition(field.condition, data)) {
			continue;
		}

		const raw = data[field.name];
		const value = typeof raw === "string" ? raw.trim() : raw;
		const isEmpty = value === undefined || value === null || value === "";

		// Required check
		if (field.required && isEmpty) {
			errors.push({ field: field.name, message: `${field.label} is required` });
			continue;
		}

		// Skip further validation if empty and not required
		if (isEmpty) {
			continue;
		}

		// Type-specific validation
		const typeError = validateFieldType(field, value);
		if (typeError) {
			errors.push({ field: field.name, message: typeError });
			continue;
		}

		// Validation rules
		const ruleErrors = validateFieldRules(field, value);
		for (const msg of ruleErrors) {
			errors.push({ field: field.name, message: msg });
		}

		if (ruleErrors.length === 0) {
			validated[field.name] = coerceValue(field.type, value);
		}
	}

	return { valid: errors.length === 0, errors, data: validated };
}

function validateFieldType(field: FormField, value: unknown): string | null {
	if (typeof value !== "string" && field.type !== "checkbox" && field.type !== "number") {
		return `${field.label} has an invalid value`;
	}

	const strValue = String(value);

	switch (field.type) {
		case "email":
			if (!EMAIL_RE.test(strValue)) return `${field.label} must be a valid email address`;
			break;
		case "url":
			if (!URL_RE.test(strValue)) return `${field.label} must be a valid URL`;
			break;
		case "tel":
			if (!TEL_RE.test(strValue)) return `${field.label} must be a valid phone number`;
			break;
		case "number": {
			const num = Number(value);
			if (Number.isNaN(num)) return `${field.label} must be a number`;
			break;
		}
		case "date":
			if (Number.isNaN(Date.parse(strValue))) return `${field.label} must be a valid date`;
			break;
		case "select":
		case "radio":
			if (field.options && !field.options.some((o) => o.value === strValue)) {
				return `${field.label} has an invalid selection`;
			}
			break;
		case "checkbox-group": {
			const values = Array.isArray(value) ? value : [value];
			if (field.options) {
				const validValues = new Set(field.options.map((o) => o.value));
				for (const v of values) {
					if (!validValues.has(String(v))) {
						return `${field.label} contains an invalid selection`;
					}
				}
			}
			break;
		}
	}

	return null;
}

function validateFieldRules(field: FormField, value: unknown): string[] {
	const errors: string[] = [];
	const v = field.validation;
	if (!v) return errors;

	const strValue = String(value);

	if (v.minLength !== undefined && strValue.length < v.minLength) {
		errors.push(`${field.label} must be at least ${v.minLength} characters`);
	}
	if (v.maxLength !== undefined && strValue.length > v.maxLength) {
		errors.push(`${field.label} must be at most ${v.maxLength} characters`);
	}

	if (field.type === "number") {
		const num = Number(value);
		if (v.min !== undefined && num < v.min) {
			errors.push(`${field.label} must be at least ${v.min}`);
		}
		if (v.max !== undefined && num > v.max) {
			errors.push(`${field.label} must be at most ${v.max}`);
		}
	}

	if (v.pattern) {
		try {
			const re = new RegExp(v.pattern);
			if (!re.test(strValue)) {
				errors.push(v.patternMessage || `${field.label} has an invalid format`);
			}
		} catch {
			// Invalid regex in config — skip pattern check
		}
	}

	return errors;
}

function coerceValue(type: FieldType, value: unknown): unknown {
	switch (type) {
		case "number":
			return Number(value);
		case "checkbox":
			return value === "on" || value === "true" || value === true;
		case "checkbox-group":
			return Array.isArray(value) ? value : [value];
		default:
			return typeof value === "string" ? value.trim() : value;
	}
}

function evaluateCondition(
	condition: { field: string; op: string; value?: string },
	data: Record<string, unknown>,
): boolean {
	const fieldValue = data[condition.field];
	// eslint-disable-next-line typescript/no-base-to-string -- form field value is a scalar at runtime
	const strValue = fieldValue === undefined || fieldValue === null ? "" : String(fieldValue);
	const isFilled = strValue !== "";

	switch (condition.op) {
		case "eq":
			return strValue === (condition.value ?? "");
		case "neq":
			return strValue !== (condition.value ?? "");
		case "filled":
			return isFilled;
		case "empty":
			return !isFilled;
		default:
			return true;
	}
}
