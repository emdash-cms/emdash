/**
 * Tests for the code block language helpers.
 *
 * Covers id/alias lookup, normalization of free-form input, and human-readable
 * label fallback. These are the helpers backing the editor's language picker
 * and the round-trip between user input and the stored `language` attribute.
 */

import { i18n } from "@lingui/core";
import { describe, it, expect } from "vitest";

import {
	CODE_BLOCK_LANGUAGES,
	findLanguage,
	languageLabelDescriptor,
	normalizeLanguage,
} from "../../src/components/editor/codeBlockLanguages";

function resolveLabel(
	label: ReturnType<typeof languageLabelDescriptor> | undefined,
): string | undefined {
	if (!label) return undefined;
	return typeof label === "string" ? label : i18n._(label);
}

describe("findLanguage", () => {
	it("returns the canonical entry for a known id", () => {
		const ts = findLanguage("typescript");
		expect(ts?.id).toBe("typescript");
		expect(resolveLabel(ts?.label)).toBe("TypeScript");
	});

	it("resolves aliases to the canonical entry", () => {
		expect(findLanguage("ts")?.id).toBe("typescript");
		expect(findLanguage("js")?.id).toBe("javascript");
		expect(findLanguage("sh")?.id).toBe("bash");
		expect(findLanguage("c++")?.id).toBe("cpp");
		expect(findLanguage("c#")?.id).toBe("csharp");
		expect(findLanguage("md")?.id).toBe("markdown");
		expect(findLanguage("yml")?.id).toBe("yaml");
	});

	it("is case-insensitive", () => {
		expect(findLanguage("TypeScript")?.id).toBe("typescript");
		expect(findLanguage("HTML")?.id).toBe("html");
		expect(findLanguage("  Python  ")?.id).toBe("python");
	});

	it("returns null for unknown or empty input", () => {
		expect(findLanguage("brainfuck")).toBeNull();
		expect(findLanguage("")).toBeNull();
		expect(findLanguage(null)).toBeNull();
		expect(findLanguage(undefined)).toBeNull();
		expect(findLanguage("   ")).toBeNull();
	});

	it("has no duplicate ids or aliases in the curated list", () => {
		const seen = new Set<string>();
		for (const lang of CODE_BLOCK_LANGUAGES) {
			expect(seen.has(lang.id), `duplicate id: ${lang.id}`).toBe(false);
			seen.add(lang.id);
			for (const alias of lang.aliases ?? []) {
				expect(seen.has(alias), `duplicate alias: ${alias}`).toBe(false);
				seen.add(alias);
			}
		}
	});
});

describe("normalizeLanguage", () => {
	it("returns the canonical id for a known language or alias", () => {
		expect(normalizeLanguage("ts")).toBe("typescript");
		expect(normalizeLanguage("TypeScript")).toBe("typescript");
		expect(normalizeLanguage("c++")).toBe("cpp");
	});

	it("lowercases and trims unknown input so class names stay stable", () => {
		expect(normalizeLanguage("  Brainfuck  ")).toBe("brainfuck");
		expect(normalizeLanguage("Erlang")).toBe("erlang");
	});

	it("collapses internal whitespace so the value remains a single class token", () => {
		// Frontend renders `<pre class="language-${id}">`; whitespace would
		// split that into two classes (`language-objective c`), so unknown
		// inputs with spaces are joined with a single hyphen.
		expect(normalizeLanguage("Objective C")).toBe("objective-c");
		expect(normalizeLanguage("My  Lang")).toBe("my-lang");
		expect(normalizeLanguage("Pure\tScript")).toBe("pure-script");
		expect(normalizeLanguage("a\nb")).toBe("a-b");
	});

	it("strips other characters that would break a CSS class token", () => {
		// Dots, slashes, and other punctuation get collapsed to `-`.
		expect(normalizeLanguage("foo.bar")).toBe("foo-bar");
		expect(normalizeLanguage("a/b")).toBe("a-b");
		expect(normalizeLanguage("plain!text")).toBe("plain-text");
	});

	it("preserves hyphens and underscores in unknown input", () => {
		expect(normalizeLanguage("my-lang")).toBe("my-lang");
		expect(normalizeLanguage("my_lang")).toBe("my_lang");
	});

	it("trims leading and trailing hyphens introduced by sanitization", () => {
		expect(normalizeLanguage("@swift")).toBe("swift");
		expect(normalizeLanguage("rust!")).toBe("rust");
		expect(normalizeLanguage("---x---")).toBe("x");
	});

	it("returns undefined for input that sanitizes to an empty string", () => {
		expect(normalizeLanguage("!!!")).toBeUndefined();
		expect(normalizeLanguage("@@@")).toBeUndefined();
	});

	it("returns undefined for empty input", () => {
		expect(normalizeLanguage("")).toBeUndefined();
		expect(normalizeLanguage(null)).toBeUndefined();
		expect(normalizeLanguage(undefined)).toBeUndefined();
		expect(normalizeLanguage("   ")).toBeUndefined();
	});
});

describe("languageLabelDescriptor", () => {
	it("returns the curated label for known languages", () => {
		expect(resolveLabel(languageLabelDescriptor("typescript"))).toBe("TypeScript");
		expect(resolveLabel(languageLabelDescriptor("ts"))).toBe("TypeScript");
		expect(resolveLabel(languageLabelDescriptor("cpp"))).toBe("C++");
	});

	it("falls back to the raw id for unknown languages", () => {
		expect(resolveLabel(languageLabelDescriptor("brainfuck"))).toBe("brainfuck");
	});

	it("returns a friendly default for empty input", () => {
		expect(resolveLabel(languageLabelDescriptor(null))).toBe("Plain text");
		expect(resolveLabel(languageLabelDescriptor(undefined))).toBe("Plain text");
		expect(resolveLabel(languageLabelDescriptor(""))).toBe("Plain text");
	});
});
