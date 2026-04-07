/**
 * SQL Identifier Validation
 *
 * Validates identifiers (table names, column names, index names) before
 * they are used in raw SQL expressions. This is the primary defense against
 * SQL injection via dynamic identifier interpolation.
 *
 * @see AGENTS.md § Database: Never Interpolate Into SQL
 */

/**
 * Pattern for safe SQL identifiers.
 * Must start with a lowercase letter, followed by lowercase letters, digits, or underscores.
 */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Pattern for generic alphanumeric identifiers (case-insensitive).
 * Must start with a letter, followed by letters, digits, or underscores.
 */
const GENERIC_IDENTIFIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Pattern for plugin identifiers.
 * Must start with a lowercase letter, followed by lowercase letters, digits, underscores, or hyphens.
 */
const PLUGIN_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Maximum length for SQL identifiers.
 * SQLite has no formal limit, but we cap at 128 for sanity.
 */
const MAX_IDENTIFIER_LENGTH = 128;

/**
 * Error thrown when an identifier fails validation.
 */
export class IdentifierError extends Error {
	constructor(
		message: string,
		public identifier: string,
	) {
		super(message);
		this.name = "IdentifierError";
	}
}

/**
 * Validate that a string is a safe SQL identifier.
 *
 * Safe identifiers match `/^[a-z][a-z0-9_]*$/` and are at most 128 characters.
 * This prevents SQL injection when identifiers must be interpolated into raw SQL
 * (e.g., dynamic table names, column names in json_extract paths).
 *
 * @param value - The string to validate
 * @param label - Human-readable label for error messages (e.g., "field name", "table name")
 * @throws {IdentifierError} If the value is not a valid identifier
 *
 * @example
 * ```typescript
 * validateIdentifier(fieldName, "field name");
 * // safe to use in: json_extract(data, '$.${fieldName}')
 * ```
 */
export function validateIdentifier(value: string, label = "identifier"): void {
	if (!value || typeof value !== "string") {
		throw new IdentifierError(`${label} must be a non-empty string`, String(value));
	}

	if (value.length > MAX_IDENTIFIER_LENGTH) {
		throw new IdentifierError(
			`${label} must be ${MAX_IDENTIFIER_LENGTH} characters or less, got ${value.length}`,
			value,
		);
	}

	if (!IDENTIFIER_PATTERN.test(value)) {
		throw new IdentifierError(`${label} must match /^[a-z][a-z0-9_]*$/ (got "${value}")`, value);
	}
}

/**
 * Validate that a string is a safe SQL identifier, allowing hyphens.
 *
 * Like `validateIdentifier` but also permits hyphens, which appear in
 * plugin IDs (e.g., "my-plugin"). Matches `/^[a-z][a-z0-9_-]*$/`.
 *
 * @param value - The string to validate
 * @param label - Human-readable label for error messages
 * @throws {IdentifierError} If the value is not valid
 */
/**
 * Validate that a string is a safe JSON field name for use in json_extract paths.
 *
 * More permissive than `validateIdentifier` — allows camelCase (mixed case)
 * since JSON keys in plugin storage data blobs commonly use camelCase.
 * Matches `/^[a-zA-Z][a-zA-Z0-9_]*$/`.
 *
 * @param value - The string to validate
 * @param label - Human-readable label for error messages
 * @throws {IdentifierError} If the value is not valid
 */
export function validateJsonFieldName(value: string, label = "JSON field name"): void {
	if (!value || typeof value !== "string") {
		throw new IdentifierError(`${label} must be a non-empty string`, String(value));
	}

	if (value.length > MAX_IDENTIFIER_LENGTH) {
		throw new IdentifierError(
			`${label} must be ${MAX_IDENTIFIER_LENGTH} characters or less, got ${value.length}`,
			value,
		);
	}

	if (!GENERIC_IDENTIFIER_PATTERN.test(value)) {
		throw new IdentifierError(
			`${label} must match /^[a-zA-Z][a-zA-Z0-9_]*$/ (got "${value}")`,
			value,
		);
	}
}

export function validatePluginIdentifier(value: string, label = "plugin identifier"): void {
	if (!value || typeof value !== "string") {
		throw new IdentifierError(`${label} must be a non-empty string`, String(value));
	}

	if (value.length > MAX_IDENTIFIER_LENGTH) {
		throw new IdentifierError(
			`${label} must be ${MAX_IDENTIFIER_LENGTH} characters or less, got ${value.length}`,
			value,
		);
	}

	if (!PLUGIN_IDENTIFIER_PATTERN.test(value)) {
		throw new IdentifierError(`${label} must match /^[a-z][a-z0-9_-]*$/ (got "${value}")`, value);
	}
}
