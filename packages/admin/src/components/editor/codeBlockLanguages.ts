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

export interface CodeBlockLanguage {
	/** Canonical identifier persisted in storage and emitted as `language-{id}`. */
	id: string;
	/** Human-readable label shown in the picker. */
	label: string;
	/** Alternative identifiers (typed by the user) that resolve to this language. */
	aliases?: string[];
}

export const CODE_BLOCK_LANGUAGES: readonly CodeBlockLanguage[] = [
	{ id: "plaintext", label: "Plain text", aliases: ["text", "plain", "txt"] },
	{ id: "astro", label: "Astro" },
	{ id: "bash", label: "Bash", aliases: ["sh", "shell", "zsh"] },
	{ id: "c", label: "C" },
	{ id: "cpp", label: "C++", aliases: ["c++"] },
	{ id: "csharp", label: "C#", aliases: ["cs", "c#"] },
	{ id: "css", label: "CSS" },
	{ id: "diff", label: "Diff", aliases: ["patch"] },
	{ id: "dockerfile", label: "Dockerfile", aliases: ["docker"] },
	{ id: "go", label: "Go", aliases: ["golang"] },
	{ id: "graphql", label: "GraphQL", aliases: ["gql"] },
	{ id: "html", label: "HTML" },
	{ id: "java", label: "Java" },
	{ id: "javascript", label: "JavaScript", aliases: ["js"] },
	{ id: "json", label: "JSON" },
	{ id: "jsx", label: "JSX" },
	{ id: "kotlin", label: "Kotlin", aliases: ["kt"] },
	{ id: "markdown", label: "Markdown", aliases: ["md"] },
	{ id: "mdx", label: "MDX" },
	{ id: "php", label: "PHP" },
	{ id: "python", label: "Python", aliases: ["py"] },
	{ id: "ruby", label: "Ruby", aliases: ["rb"] },
	{ id: "rust", label: "Rust", aliases: ["rs"] },
	{ id: "scss", label: "SCSS", aliases: ["sass"] },
	{ id: "sql", label: "SQL" },
	{ id: "svelte", label: "Svelte" },
	{ id: "swift", label: "Swift" },
	{ id: "toml", label: "TOML" },
	{ id: "tsx", label: "TSX" },
	{ id: "typescript", label: "TypeScript", aliases: ["ts"] },
	{ id: "vue", label: "Vue" },
	{ id: "xml", label: "XML" },
	{ id: "yaml", label: "YAML", aliases: ["yml"] },
];

/**
 * Look up a language by id or alias. Case-insensitive.
 * Returns the canonical entry, or `null` if not found in the curated list.
 */
export function findLanguage(value: string | null | undefined): CodeBlockLanguage | null {
	if (!value) return null;
	const needle = value.trim().toLowerCase();
	if (!needle) return null;
	for (const lang of CODE_BLOCK_LANGUAGES) {
		if (lang.id === needle) return lang;
		if (lang.aliases?.includes(needle)) return lang;
	}
	return null;
}

/**
 * Normalize a user-entered language string to a canonical id where possible.
 * Unknown inputs are returned trimmed and lowercased so they round-trip
 * predictably and produce stable `language-{id}` class names.
 *
 * Returns `undefined` for empty/whitespace input.
 */
export function normalizeLanguage(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const match = findLanguage(trimmed);
	if (match) return match.id;
	return trimmed.toLowerCase();
}

/**
 * Human-readable label for a stored language id. Falls back to the id itself
 * for unknown values so the editor never shows "undefined".
 */
export function languageLabel(value: string | null | undefined): string {
	if (!value) return "Plain text";
	const match = findLanguage(value);
	if (match) return match.label;
	return value;
}
