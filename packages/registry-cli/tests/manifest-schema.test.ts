/**
 * Coverage for the `emdash-plugin.jsonc` Zod schema.
 *
 * The schema is the authoring contract with plugin publishers. A regression
 * here means user-visible behaviour change in the field names, validation
 * rules, or error messages that publishers rely on. Tests are organised by
 * field so a future field add lands cleanly alongside its own test block.
 *
 * Where applicable, tests assert on the EXACT Zod issue path / message
 * because those strings surface in `emdash-registry validate` output --
 * users see them, and silently changing them breaks anyone who built
 * tooling around the strings.
 */

import { describe, expect, it } from "vitest";

import {
	AuthorSchema,
	LicenseSchema,
	ManifestSchema,
	RepoSchema,
	SecurityContactSchema,
} from "../src/manifest/schema.js";

describe("LicenseSchema", () => {
	it("accepts a typical SPDX expression", () => {
		expect(LicenseSchema.parse("MIT")).toBe("MIT");
		expect(LicenseSchema.parse("Apache-2.0")).toBe("Apache-2.0");
		expect(LicenseSchema.parse("MIT OR Apache-2.0")).toBe("MIT OR Apache-2.0");
	});

	it("rejects the empty string", () => {
		const result = LicenseSchema.safeParse("");
		expect(result.success).toBe(false);
	});

	it("rejects a whitespace-only license", () => {
		const result = LicenseSchema.safeParse("   ");
		expect(result.success).toBe(false);
	});

	it("rejects values over 256 characters", () => {
		const result = LicenseSchema.safeParse("A".repeat(257));
		expect(result.success).toBe(false);
	});
});

describe("AuthorSchema", () => {
	it("accepts the minimal name-only form", () => {
		expect(AuthorSchema.parse({ name: "Jane Doe" })).toEqual({ name: "Jane Doe" });
	});

	it("accepts name + url + email", () => {
		const author = {
			name: "Jane Doe",
			url: "https://example.com",
			email: "jane@example.com",
		};
		expect(AuthorSchema.parse(author)).toEqual(author);
	});

	it("rejects an empty name", () => {
		const result = AuthorSchema.safeParse({ name: "" });
		expect(result.success).toBe(false);
	});

	it("rejects unknown keys (strict mode)", () => {
		const result = AuthorSchema.safeParse({ name: "Jane", website: "https://example.com" });
		expect(result.success).toBe(false);
	});

	it("rejects a malformed URL", () => {
		const result = AuthorSchema.safeParse({ name: "Jane", url: "not-a-url" });
		expect(result.success).toBe(false);
	});

	it("rejects a malformed email", () => {
		const result = AuthorSchema.safeParse({ name: "Jane", email: "not-an-email" });
		expect(result.success).toBe(false);
	});
});

describe("SecurityContactSchema", () => {
	it("accepts an email-only contact", () => {
		expect(SecurityContactSchema.parse({ email: "security@example.com" })).toEqual({
			email: "security@example.com",
		});
	});

	it("accepts a url-only contact", () => {
		expect(SecurityContactSchema.parse({ url: "https://example.com/security" })).toEqual({
			url: "https://example.com/security",
		});
	});

	it("rejects an empty contact (no email or url)", () => {
		const result = SecurityContactSchema.safeParse({});
		expect(result.success).toBe(false);
		if (!result.success) {
			// The exact message users see at validate-time; pin it.
			expect(result.error.issues[0]?.message).toContain("at least one of `url` or `email`");
		}
	});
});

describe("RepoSchema", () => {
	it("accepts an https:// URL", () => {
		expect(RepoSchema.parse("https://github.com/example/plugin")).toBe(
			"https://github.com/example/plugin",
		);
	});

	it("rejects http:// URLs", () => {
		const result = RepoSchema.safeParse("http://github.com/example/plugin");
		expect(result.success).toBe(false);
	});

	it("rejects non-URL strings", () => {
		const result = RepoSchema.safeParse("not a url");
		expect(result.success).toBe(false);
	});
});

describe("ManifestSchema (full document)", () => {
	const minimal = {
		license: "MIT",
		author: { name: "Jane Doe" },
		security: { email: "security@example.com" },
	};

	it("accepts the minimal required shape", () => {
		const result = ManifestSchema.safeParse(minimal);
		expect(result.success).toBe(true);
	});

	it("accepts a manifest with $schema for IDE completion", () => {
		const result = ManifestSchema.safeParse({
			...minimal,
			$schema: "./node_modules/@emdash-cms/registry-cli/schemas/emdash-plugin.schema.json",
		});
		expect(result.success).toBe(true);
	});

	it("accepts the multi-author/multi-contact form", () => {
		const result = ManifestSchema.safeParse({
			license: "MIT",
			authors: [{ name: "Alice" }, { name: "Bob" }],
			securityContacts: [{ email: "alice@example.com" }, { url: "https://example.com/security" }],
		});
		expect(result.success).toBe(true);
	});

	it("rejects mixing `author` and `authors`", () => {
		const result = ManifestSchema.safeParse({
			license: "MIT",
			author: { name: "Alice" },
			authors: [{ name: "Bob" }],
			security: { email: "security@example.com" },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("both `author` and `authors`");
		}
	});

	it("rejects mixing `security` and `securityContacts`", () => {
		const result = ManifestSchema.safeParse({
			license: "MIT",
			author: { name: "Alice" },
			security: { email: "a@example.com" },
			securityContacts: [{ email: "b@example.com" }],
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("both `security` and `securityContacts`");
		}
	});

	it("requires either `author` or `authors`", () => {
		const result = ManifestSchema.safeParse({
			license: "MIT",
			security: { email: "security@example.com" },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("`author: { ... }`");
		}
	});

	it("requires either `security` or `securityContacts`", () => {
		const result = ManifestSchema.safeParse({
			license: "MIT",
			author: { name: "Alice" },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("`security: { ... }`");
		}
	});

	it("rejects unknown top-level keys (strict mode catches typos)", () => {
		const result = ManifestSchema.safeParse({
			...minimal,
			licens: "MIT", // typo
		});
		expect(result.success).toBe(false);
	});

	it("rejects an empty authors array (lexicon requires >= 1)", () => {
		const result = ManifestSchema.safeParse({
			license: "MIT",
			authors: [],
			security: { email: "security@example.com" },
		});
		expect(result.success).toBe(false);
	});

	it("rejects more than 32 authors (lexicon cap)", () => {
		const authors = Array.from({ length: 33 }, (_, i) => ({ name: `Author ${i}` }));
		const result = ManifestSchema.safeParse({
			license: "MIT",
			authors,
			security: { email: "security@example.com" },
		});
		expect(result.success).toBe(false);
	});

	it("rejects more than 5 keywords (FAIR convention)", () => {
		const result = ManifestSchema.safeParse({
			...minimal,
			keywords: ["a", "b", "c", "d", "e", "f"],
		});
		expect(result.success).toBe(false);
	});

	it("accepts a full populated manifest", () => {
		const result = ManifestSchema.safeParse({
			$schema: "./node_modules/@emdash-cms/registry-cli/schemas/emdash-plugin.schema.json",
			license: "MIT",
			author: {
				name: "Jane Doe",
				url: "https://example.com",
				email: "jane@example.com",
			},
			security: {
				email: "security@example.com",
				url: "https://example.com/security",
			},
			name: "Gallery",
			description: "Image gallery block for EmDash.",
			keywords: ["gallery", "images", "media"],
			repo: "https://github.com/emdash-cms/plugin-gallery",
		});
		expect(result.success).toBe(true);
	});
});
