/**
 * Curated list of code block languages.
 *
 * Used as suggestions in the editor's language picker. The picker accepts
 * free-form text, so this is a starting point, not a restriction. The `id`
 * is the canonical identifier persisted in the Portable Text `language`
 * field and emitted as a `language-{id}` CSS class on the frontend.
 *
 * Aliases let common variants ("typescript", "ts") resolve to the same id.
 * Frontend highlighters (shipped in a follow-up PR) will use this map to
 * normalize unknown inputs.
 */

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export interface CodeBlockLanguage {
	/** Canonical identifier persisted in storage and emitted as `language-{id}`. */
	id: string;
	/** Human-readable label shown in the picker. */
	label: MessageDescriptor;
	/** Alternative identifiers (typed by the user) that resolve to this language. */
	aliases?: string[];
}

export const CODE_BLOCK_LANGUAGES: readonly CodeBlockLanguage[] = [
	{ id: "plaintext", label: msg`Plain text`, aliases: ["text", "plain", "txt"] },
	{ id: "astro", label: msg`Astro` },
	{ id: "bash", label: msg`Bash`, aliases: ["sh", "shell", "zsh"] },
	{ id: "c", label: msg`C` },
	{ id: "cpp", label: msg`C++`, aliases: ["c++"] },
	{ id: "csharp", label: msg`C#`, aliases: ["cs", "c#"] },
	{ id: "css", label: msg`CSS` },
	{ id: "diff", label: msg`Diff`, aliases: ["patch"] },
	{ id: "dockerfile", label: msg`Dockerfile`, aliases: ["docker"] },
	{ id: "go", label: msg`Go`, aliases: ["golang"] },
	{ id: "graphql", label: msg`GraphQL`, aliases: ["gql"] },
	{ id: "html", label: msg`HTML` },
	{ id: "java", label: msg`Java` },
	{ id: "javascript", label: msg`JavaScript`, aliases: ["js"] },
	{ id: "json", label: msg`JSON` },
	{ id: "jsx", label: msg`JSX` },
	{ id: "kotlin", label: msg`Kotlin`, aliases: ["kt"] },
	{ id: "markdown", label: msg`Markdown`, aliases: ["md"] },
	{ id: "mdx", label: msg`MDX` },
	{ id: "php", label: msg`PHP` },
	{ id: "python", label: msg`Python`, aliases: ["py"] },
	{ id: "ruby", label: msg`Ruby`, aliases: ["rb"] },
	{ id: "rust", label: msg`Rust`, aliases: ["rs"] },
	{ id: "scss", label: msg`SCSS`, aliases: ["sass"] },
	{ id: "sql", label: msg`SQL` },
	{ id: "svelte", label: msg`Svelte` },
	{ id: "swift", label: msg`Swift` },
	{ id: "toml", label: msg`TOML` },
	{ id: "tsx", label: msg`TSX` },
	{ id: "typescript", label: msg`TypeScript`, aliases: ["ts"] },
	{ id: "vue", label: msg`Vue` },
	{ id: "xml", label: msg`XML` },
	{ id: "yaml", label: msg`YAML`, aliases: ["yml"] },
];

/**
 * Look up a language by id or alias. Case-insensitive.
 * Returns the canonical entry, or `null` if not found in the curated list.
 */
export function findLanguage(value: string | null | undefined): CodeBlockLanguage | null {
	if (!value) return null;
	const searchText = value.trim().toLowerCase();
	if (!searchText) return null;
	for (const lang of CODE_BLOCK_LANGUAGES) {
		if (lang.id === searchText) return lang;
		if (lang.aliases?.includes(searchText)) return lang;
	}
	return null;
}

/**
 * Normalize a user-entered language string to a canonical id where possible.
 * Unknown inputs are sanitized to a single safe class token: lowercased,
 * trimmed, with any character outside `[a-z0-9_-]` (including whitespace,
 * dots, slashes, etc.) collapsed to `-`. This keeps the stored value safe
 * to interpolate into a `language-{id}` CSS class without splitting on
 * whitespace.
 *
 * Examples:
 *   normalizeLanguage("TypeScript")   -> "typescript" (canonical id)
 *   normalizeLanguage("ts")           -> "typescript" (alias)
 *   normalizeLanguage("Objective C")  -> "objective-c" (sanitized)
 *   normalizeLanguage("F#")           -> "f-" (sanitized)
 *   normalizeLanguage("")             -> undefined
 */
// Hoisted to module scope to avoid re-compilation on every call.
const DISALLOWED_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_TRAILING_HYPHENS_RE = /^-+|-+$/g;

export function normalizeLanguage(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const match = findLanguage(trimmed);
	if (match) return match.id;
	// Sanitize unknown input: lowercase, then collapse runs of disallowed
	// characters into a single `-` so the result is always a single CSS class
	// token. We deliberately don't return `undefined` on collisions here --
	// callers can compare the sanitized result with the input if they need to.
	const sanitized = trimmed
		.toLowerCase()
		.replace(DISALLOWED_CHARS_RE, "-")
		.replace(LEADING_TRAILING_HYPHENS_RE, "");
	return sanitized || undefined;
}

/**
 * Human-readable label for a stored language id. Falls back to the id itself
 * for unknown values so the editor never shows "undefined".
 */
export function languageLabelDescriptor(
	value: string | null | undefined,
): MessageDescriptor | string {
	if (!value) return msg`Plain text`;
	const match = findLanguage(value);
	if (match) return match.label;
	return value;
}
