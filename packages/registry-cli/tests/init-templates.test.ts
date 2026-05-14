/**
 * Coverage for the init scaffolder's pure template functions.
 *
 * Tests focus on the manifest renderer because that's the file users
 * see first and the one whose shape has to satisfy the schema. The
 * other templates (package.json, tsconfig, README) get smoke checks
 * that they produce valid JSON / non-empty content; their exact
 * wording is verified by the integration test in init-scaffold.test.ts.
 */

import { describe, expect, it } from "vitest";

import {
	renderGitignore,
	renderManifest,
	renderPackageJson,
	renderPluginEntry,
	renderReadme,
	renderTest,
	renderTsconfig,
	type ScaffoldInputs,
} from "../src/init/templates.js";
import { ManifestSchema } from "../src/manifest/schema.js";

const FULL_INPUTS: ScaffoldInputs = {
	slug: "gallery",
	publisher: "did:plc:abc123def456",
	publisherHandle: "example.com",
	license: "MIT",
	author: { name: "Jane Doe", url: "https://example.com", email: "jane@example.com" },
	security: { email: "security@example.com" },
	description: "Image gallery plugin",
	repo: "https://github.com/example/gallery",
};

const MINIMAL_INPUTS: ScaffoldInputs = {
	slug: "gallery",
	publisher: undefined,
	publisherHandle: undefined,
	license: undefined,
	author: undefined,
	security: undefined,
	description: undefined,
	repo: undefined,
};

describe("renderManifest (fully-populated)", () => {
	it("produces a manifest that passes the schema", () => {
		const source = renderManifest(FULL_INPUTS);
		// JSONC parser strips comments and trailing commas before
		// validation. We parse via the same loader path the CLI uses
		// elsewhere, but for the test a quick `parse` from jsonc-parser
		// is enough — we only need to confirm the rendered bytes
		// validate.
		const parsed = parseJsonc(source);
		const result = ManifestSchema.safeParse(parsed);
		expect(result.success).toBe(true);
	});

	it("renders identity, license, author, security, description, repo", () => {
		const source = renderManifest(FULL_INPUTS);
		expect(source).toContain('"slug": "gallery"');
		expect(source).toContain('"version": "0.1.0"');
		expect(source).toContain('"publisher": "did:plc:abc123def456"');
		expect(source).toContain('"license": "MIT"');
		expect(source).toContain('"name": "Jane Doe"');
		// author's url. The publisher comment also contains "example.com",
		// so we anchor on the author block by looking for the
		// url-key shape rather than the bare hostname.
		expect(source).toContain('"url": "https://example.com"');
		expect(source).toContain('"email": "jane@example.com"');
		expect(source).toContain('"email": "security@example.com"');
		expect(source).toContain('"description": "Image gallery plugin"');
		expect(source).toContain('"repo": "https://github.com/example/gallery"');
	});

	it("includes the handle as a line comment next to the pinned DID", () => {
		const source = renderManifest(FULL_INPUTS);
		const publisherLine = source.split("\n").find((l) => l.includes('"publisher"'))!;
		expect(publisherLine).toBeDefined();
		expect(publisherLine).toContain("// example.com");
	});

	it("omits the publisher comment when no handle is known (DID-only input)", () => {
		const source = renderManifest({ ...FULL_INPUTS, publisherHandle: undefined });
		const publisherLine = source.split("\n").find((l) => l.includes('"publisher"'))!;
		expect(publisherLine).toBeDefined();
		expect(publisherLine).not.toContain("//");
	});

	it("includes the $schema reference for IDE completion", () => {
		const source = renderManifest(FULL_INPUTS);
		expect(source).toContain(
			'"$schema": "./node_modules/@emdash-cms/registry-cli/schemas/emdash-plugin.schema.json"',
		);
	});

	it("emits empty default arrays for the trust contract", () => {
		// init starts with no declared capabilities. The author opts in.
		const source = renderManifest(FULL_INPUTS);
		expect(source).toContain('"capabilities": []');
		expect(source).toContain('"allowedHosts": []');
		expect(source).toContain('"storage": {}');
	});
});

describe("renderManifest (minimal — no flags, no prompts)", () => {
	it("produces a manifest with TODO placeholders", () => {
		const source = renderManifest(MINIMAL_INPUTS);
		// Three TODOs: publisher, author, security. License has a
		// default (MIT) so it never carries a TODO.
		const todoLines = source.split("\n").filter((line) => line.includes("TODO"));
		expect(todoLines.length).toBeGreaterThanOrEqual(3);
		// At least one TODO mentions atproto (publisher), one mentions
		// the author name, one mentions security.
		expect(todoLines.some((l) => /atproto handle|DID/i.test(l))).toBe(true);
		expect(todoLines.some((l) => /name|author/i.test(l))).toBe(true);
		expect(todoLines.some((l) => /security/i.test(l))).toBe(true);
	});

	it("emits an empty publisher value the schema will reject", () => {
		// The TODO is visible to the user; the empty string is what
		// schema validation hits. This is intentional: the manifest is
		// "valid JSONC, schema-invalid until publisher is filled in".
		const source = renderManifest(MINIMAL_INPUTS);
		expect(source).toContain('"publisher": ""');
	});

	it("defaults license to MIT when unset", () => {
		const source = renderManifest(MINIMAL_INPUTS);
		expect(source).toContain('"license": "MIT"');
	});

	it("renders to the smallest plausible manifest", () => {
		// description and repo are truly-optional fields. They must
		// not appear when unset (no empty-string keys lying around).
		const source = renderManifest(MINIMAL_INPUTS);
		expect(source).not.toMatch(/"description":/);
		expect(source).not.toMatch(/"repo":/);
	});
});

describe("renderManifest (partial author/security)", () => {
	it("emits author.url and author.email only when provided", () => {
		const source = renderManifest({
			...FULL_INPUTS,
			author: { name: "Jane Doe" }, // no url, no email
		});
		expect(source).toContain('"name": "Jane Doe"');
		expect(source).not.toContain('"url":');
		expect(source).not.toContain('"jane@example.com"');
	});

	it("emits security.url when only the url is provided", () => {
		const source = renderManifest({
			...FULL_INPUTS,
			security: { url: "https://example.com/security" },
		});
		expect(source).toContain('"url": "https://example.com/security"');
	});
});

describe("renderPackageJson", () => {
	it("uses the slug as the package name and marks it private", () => {
		const parsed = JSON.parse(renderPackageJson(FULL_INPUTS));
		expect(parsed.name).toBe("gallery");
		expect(parsed.private).toBe(true);
		expect(parsed.type).toBe("module");
	});

	it("ships typecheck + test scripts only — no build", () => {
		const parsed = JSON.parse(renderPackageJson(FULL_INPUTS));
		expect(Object.keys(parsed.scripts)).toEqual(["typecheck", "test"]);
	});

	it("doesn't ship main, exports, or files (no npm publishing path)", () => {
		const parsed = JSON.parse(renderPackageJson(FULL_INPUTS));
		expect(parsed.main).toBeUndefined();
		expect(parsed.exports).toBeUndefined();
		expect(parsed.files).toBeUndefined();
	});
});

describe("renderTsconfig", () => {
	it("produces a strict standalone tsconfig", () => {
		const parsed = JSON.parse(renderTsconfig());
		expect(parsed.compilerOptions.strict).toBe(true);
		// No outDir / declaration — source is the artefact, bundle
		// transpiles at publish time.
		expect(parsed.compilerOptions.outDir).toBeUndefined();
		expect(parsed.compilerOptions.declaration).toBeUndefined();
	});

	it("includes both src and tests", () => {
		const parsed = JSON.parse(renderTsconfig());
		expect(parsed.include).toContain("src/**/*");
		expect(parsed.include).toContain("tests/**/*");
	});
});

describe("renderPluginEntry", () => {
	it("imports definePlugin and PluginContext from emdash", () => {
		const source = renderPluginEntry();
		expect(source).toContain('import { definePlugin } from "emdash"');
		expect(source).toContain('import type { PluginContext } from "emdash"');
	});

	it("default-exports a definePlugin call with a hello route", () => {
		const source = renderPluginEntry();
		expect(source).toContain("export default definePlugin");
		expect(source).toContain("hello:");
		expect(source).toContain("greeting:");
	});
});

describe("renderTest", () => {
	it("imports the plugin and exercises the hello route", () => {
		const source = renderTest();
		expect(source).toContain('from "../src/plugin.js"');
		expect(source).toContain("hello");
		expect(source).toContain("expect(result)");
	});
});

describe("renderGitignore", () => {
	it("ignores node_modules", () => {
		expect(renderGitignore()).toContain("node_modules");
	});

	it("does not ignore dist — the scaffold has no dist", () => {
		expect(renderGitignore()).not.toContain("dist");
	});
});

describe("renderReadme", () => {
	it("documents the publish path", () => {
		const source = renderReadme(FULL_INPUTS);
		expect(source).toContain("emdash-registry bundle");
		expect(source).toContain("emdash-registry publish");
	});

	it("documents version-bump rules for the trust contract", () => {
		const source = renderReadme(FULL_INPUTS);
		expect(source).toContain("capabilities");
		expect(source).toContain("trust contract");
	});

	it("uses the slug as the title", () => {
		const source = renderReadme(FULL_INPUTS);
		expect(source.split("\n")[0]).toBe("# gallery");
	});
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse JSONC for testing the rendered manifest. We use the
 * jsonc-parser dep directly here rather than going through the full
 * loader because the loader requires a file path and we want to
 * keep these tests in-memory.
 */
function parseJsonc(source: string): unknown {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { parse } = require("jsonc-parser") as typeof import("jsonc-parser");
	const errors: import("jsonc-parser").ParseError[] = [];
	const value: unknown = parse(source, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	if (errors.length > 0) {
		throw new Error(`JSONC parse errors: ${JSON.stringify(errors)}`);
	}
	return value;
}
