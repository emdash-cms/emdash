/**
 * Coverage for the manifest -> publish translation layer.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	manifestToProfileBootstrap,
	manifestToProfileInput,
	normaliseManifest,
	type NormalisedManifest,
	resolveSections,
	SectionError,
} from "../src/manifest/translate.js";

describe("normaliseManifest", () => {
	it("collapses single-author into authors[]", () => {
		const normalised = normaliseManifest({
			version: "0.1.0",
			license: "MIT",
			author: { name: "Jane" },
			security: { email: "s@example.com" },
		});
		expect(normalised.authors).toEqual([{ name: "Jane" }]);
		// Single security contact normalised to array.
		expect(normalised.securityContacts).toEqual([{ email: "s@example.com" }]);
	});

	it("passes the multi-author array through unchanged", () => {
		const normalised = normaliseManifest({
			version: "0.1.0",
			license: "MIT",
			authors: [{ name: "A" }, { name: "B" }],
			securityContacts: [{ email: "s@example.com" }],
		});
		expect(normalised.authors).toEqual([{ name: "A" }, { name: "B" }]);
	});

	it("propagates publisher when set", () => {
		const normalised = normaliseManifest({
			version: "0.1.0",
			license: "MIT",
			publisher: "did:plc:abc",
			author: { name: "Jane" },
			security: { email: "s@example.com" },
		});
		expect(normalised.publisher).toBe("did:plc:abc");
	});

	it("uses package.json version when manifest omits it", () => {
		const normalised = normaliseManifest(
			{
				license: "MIT",
				author: { name: "Jane" },
				security: { email: "s@example.com" },
			},
			"1.2.3",
		);
		expect(normalised.version).toBe("1.2.3");
	});

	it("uses manifest version when no package.json version is provided", () => {
		const normalised = normaliseManifest({
			version: "0.9.0",
			license: "MIT",
			author: { name: "Jane" },
			security: { email: "s@example.com" },
		});
		expect(normalised.version).toBe("0.9.0");
	});

	it("accepts matching versions from both sources", () => {
		const normalised = normaliseManifest(
			{
				version: "2.0.0",
				license: "MIT",
				author: { name: "Jane" },
				security: { email: "s@example.com" },
			},
			"2.0.0",
		);
		expect(normalised.version).toBe("2.0.0");
	});

	it("throws on mismatched versions", () => {
		expect(() =>
			normaliseManifest(
				{
					version: "1.0.0",
					license: "MIT",
					author: { name: "Jane" },
					security: { email: "s@example.com" },
				},
				"2.0.0",
			),
		).toThrow(/disagrees/);
	});

	it("passes release-level requires through unchanged", () => {
		const normalised = normaliseManifest({
			version: "0.1.0",
			license: "MIT",
			author: { name: "Jane" },
			security: { email: "s@example.com" },
			release: { requires: { "env:emdash": ">=1.0.0", "env:astro": ">=4.16" } },
		});
		expect(normalised.requires).toEqual({ "env:emdash": ">=1.0.0", "env:astro": ">=4.16" });
	});

	it("leaves requires undefined when the manifest omits it", () => {
		const normalised = normaliseManifest({
			version: "0.1.0",
			license: "MIT",
			author: { name: "Jane" },
			security: { email: "s@example.com" },
		});
		expect(normalised.requires).toBeUndefined();
	});

	it("throws when no version is available anywhere", () => {
		expect(() =>
			normaliseManifest({
				license: "MIT",
				author: { name: "Jane" },
				security: { email: "s@example.com" },
			}),
		).toThrow(/not set/);
	});
});

describe("manifestToProfileBootstrap", () => {
	it("maps the publish-relevant subset of fields", () => {
		const normalised: NormalisedManifest = {
			slug: "test",
			version: "0.1.0",
			license: "MIT",
			publisher: "did:plc:abc",
			authors: [{ name: "Jane", url: "https://example.com" }],
			securityContacts: [{ email: "s@example.com" }],
			name: "Test",
			description: "desc",
			keywords: ["k"],
			repo: "https://github.com/example/p",
			requires: undefined,
			capabilities: [],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
		};
		const bootstrap = manifestToProfileBootstrap(normalised);
		expect(bootstrap.license).toBe("MIT");
		expect(bootstrap.authorName).toBe("Jane");
		expect(bootstrap.authorUrl).toBe("https://example.com");
		expect(bootstrap.securityEmail).toBe("s@example.com");
	});

	it("uses the first author when multiple are provided", () => {
		const normalised: NormalisedManifest = {
			slug: "test",
			version: "0.1.0",
			license: "MIT",
			publisher: "did:plc:abc",
			authors: [{ name: "First" }, { name: "Second" }],
			securityContacts: [{ email: "s@example.com" }],
			name: undefined,
			description: undefined,
			keywords: undefined,
			repo: undefined,
			requires: undefined,
			capabilities: [],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
		};
		const bootstrap = manifestToProfileBootstrap(normalised);
		expect(bootstrap.authorName).toBe("First");
	});
});

describe("manifestToProfileInput", () => {
	it("carries the full lexicon profile block (multi-author, multi-security)", () => {
		const normalised: NormalisedManifest = {
			slug: "test",
			version: "0.1.0",
			license: "Apache-2.0",
			publisher: "did:plc:abc",
			authors: [
				{ name: "Jane", url: "https://example.com" },
				{ name: "Bob", email: "bob@example.com" },
			],
			securityContacts: [{ email: "s@example.com" }, { url: "https://example.com/sec" }],
			name: "Test",
			description: "desc",
			keywords: ["k1", "k2"],
			repo: "https://github.com/example/p",
			requires: { "env:astro": ">=4.16" },
			capabilities: [],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
		};
		const input = manifestToProfileInput(normalised);
		expect(input.license).toBe("Apache-2.0");
		expect(input.authors).toEqual([
			{ name: "Jane", url: "https://example.com" },
			{ name: "Bob", email: "bob@example.com" },
		]);
		expect(input.security).toEqual([
			{ email: "s@example.com" },
			{ url: "https://example.com/sec" },
		]);
		expect(input.name).toBe("Test");
		expect(input.description).toBe("desc");
		expect(input.keywords).toEqual(["k1", "k2"]);
		// requires is release-level, never folded into the profile input.
		expect("requires" in input).toBe(false);
	});

	it("omits name, description and keywords when the manifest doesn't set them", () => {
		const normalised: NormalisedManifest = {
			slug: "test",
			version: "0.1.0",
			license: "MIT",
			publisher: "did:plc:abc",
			authors: [{ name: "Solo" }],
			securityContacts: [{ email: "s@example.com" }],
			name: undefined,
			description: undefined,
			keywords: undefined,
			repo: undefined,
			requires: undefined,
			capabilities: [],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
		};
		const input = manifestToProfileInput(normalised);
		expect("name" in input).toBe(false);
		expect("description" in input).toBe(false);
		expect("keywords" in input).toBe(false);
		expect("sections" in input).toBe(false);
	});

	it("carries resolved sections into the profile input", () => {
		const normalised: NormalisedManifest = {
			slug: "test",
			version: "0.1.0",
			license: "MIT",
			publisher: "did:plc:abc",
			authors: [{ name: "Solo" }],
			securityContacts: [{ email: "s@example.com" }],
			name: undefined,
			description: undefined,
			keywords: undefined,
			repo: undefined,
			requires: undefined,
			sections: { description: "Long.", installation: "Run install." },
			capabilities: [],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
		};
		const input = manifestToProfileInput(normalised);
		expect(input.sections).toEqual({ description: "Long.", installation: "Run install." });
	});

	it("omits sections when the resolved map is empty or undefined", () => {
		const base: NormalisedManifest = {
			slug: "test",
			version: "0.1.0",
			license: "MIT",
			publisher: "did:plc:abc",
			authors: [{ name: "Solo" }],
			securityContacts: [{ email: "s@example.com" }],
			name: undefined,
			description: undefined,
			keywords: undefined,
			repo: undefined,
			requires: undefined,
			capabilities: [],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
		};
		expect("sections" in manifestToProfileInput(base)).toBe(false);
		expect("sections" in manifestToProfileInput({ ...base, sections: {} })).toBe(false);
	});
});

describe("resolveSections", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-sections-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns undefined when the manifest declared no sections", async () => {
		expect(await resolveSections(undefined, dir)).toBeUndefined();
	});

	it("passes inline strings through unchanged", async () => {
		const resolved = await resolveSections({ description: "Inline desc.", faq: "Q&A." }, dir);
		expect(resolved).toEqual({ description: "Inline desc.", faq: "Q&A." });
	});

	it("reads a { file } ref's content into the section", async () => {
		await writeFile(join(dir, "install.md"), "# Install\n\nRun `pnpm add`.");
		const resolved = await resolveSections({ installation: { file: "./install.md" } }, dir);
		expect(resolved).toEqual({ installation: "# Install\n\nRun `pnpm add`." });
	});

	it("leaves unset keys out of the resolved map", async () => {
		const resolved = await resolveSections({ description: "Only this." }, dir);
		expect(resolved).toEqual({ description: "Only this." });
		expect(resolved && "faq" in resolved).toBe(false);
	});

	it("rejects a file ref that escapes the manifest directory", async () => {
		await expect(
			resolveSections({ security: { file: "../secrets.md" } }, dir),
		).rejects.toMatchObject({ code: "SECTION_PATH_ESCAPE" });
	});

	it("rejects an absolute file ref", async () => {
		await expect(
			resolveSections({ security: { file: "/etc/passwd" } }, dir),
		).rejects.toBeInstanceOf(SectionError);
	});

	it("rejects an unreadable file ref", async () => {
		await expect(
			resolveSections({ changelog: { file: "./missing.md" } }, dir),
		).rejects.toMatchObject({ code: "SECTION_FILE_UNREADABLE" });
	});

	it("rejects a file whose content exceeds the byte cap", async () => {
		await writeFile(join(dir, "big.md"), "a".repeat(20001));
		await expect(resolveSections({ description: { file: "./big.md" } }, dir)).rejects.toMatchObject(
			{ code: "SECTION_TOO_LARGE" },
		);
	});

	it("rejects a file whose content exceeds the grapheme cap", async () => {
		await writeFile(join(dir, "emoji.md"), "😀".repeat(2001));
		await expect(resolveSections({ faq: { file: "./emoji.md" } }, dir)).rejects.toMatchObject({
			code: "SECTION_TOO_LARGE",
		});
	});
});
