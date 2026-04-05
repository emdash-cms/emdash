import { CodeBlock as KumoCodeBlock } from "@cloudflare/kumo";

import type { CodeBlock } from "../types.js";

/** Languages supported by Kumo's CodeBlock component. */
type SupportedLang = "ts" | "tsx" | "jsonc" | "bash" | "css";

const SUPPORTED_LANGS = new Set<string>(["ts", "tsx", "jsonc", "bash", "css"]);

/** Map common language names to their Kumo equivalents. */
const LANG_ALIASES: Record<string, SupportedLang> = {
	json: "jsonc",
	javascript: "ts",
	typescript: "ts",
	js: "ts",
	sh: "bash",
	shell: "bash",
};

/**
 * Normalize a language string to a Kumo-supported value.
 * Falls back to "bash" (plain monospace rendering) for unknown languages.
 */
function normalizeLang(lang?: string): SupportedLang {
	if (!lang) return "bash";
	if (SUPPORTED_LANGS.has(lang)) return lang as SupportedLang;
	return LANG_ALIASES[lang] ?? "bash";
}

export function CodeBlockComponent({ block }: { block: CodeBlock }) {
	return <KumoCodeBlock code={block.code} lang={normalizeLang(block.language)} />;
}
