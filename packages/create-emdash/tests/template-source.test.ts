import { describe, expect, it } from "vitest";

import { GITHUB_REPO, resolveTemplateSource } from "../src/template-source.js";

/**
 * Pure resolution of the giget source for a template. No network — the
 * function only maps (template key, platform, env) to `{ repo, dir }`.
 */

function env(repo?: string): { EMDASH_TEMPLATES_REPO?: string } {
	return repo === undefined ? {} : { EMDASH_TEMPLATES_REPO: repo };
}

describe("resolveTemplateSource", () => {
	it("uses the default repo when EMDASH_TEMPLATES_REPO is absent", () => {
		const source = resolveTemplateSource("blog", "cloudflare", env());
		expect(source.repo).toBe(GITHUB_REPO);
		expect(source.repo).toBe("emdash-cms/templates");
		expect(source.dir).toBe("blog-cloudflare");
	});

	it("resolves known keys to their platform dirs on node", () => {
		expect(resolveTemplateSource("blog", "node", env()).dir).toBe("blog");
		expect(resolveTemplateSource("starter", "node", env()).dir).toBe("starter");
		expect(resolveTemplateSource("marketing", "node", env()).dir).toBe("marketing");
		expect(resolveTemplateSource("portfolio", "node", env()).dir).toBe("portfolio");
	});

	it("applies the -cloudflare suffix rule for known keys on cloudflare", () => {
		expect(resolveTemplateSource("blog", "cloudflare", env()).dir).toBe("blog-cloudflare");
		expect(resolveTemplateSource("portfolio", "cloudflare", env()).dir).toBe(
			"portfolio-cloudflare",
		);
	});

	it("overrides the repo via EMDASH_TEMPLATES_REPO", () => {
		const source = resolveTemplateSource("blog", "node", env("my-org/emdash-templates"));
		expect(source.repo).toBe("my-org/emdash-templates");
		expect(source.dir).toBe("blog");
	});

	it("keeps known-key dir resolution unchanged under an overridden repo", () => {
		const source = resolveTemplateSource("starter", "cloudflare", env("my-org/emdash-templates"));
		expect(source.repo).toBe("my-org/emdash-templates");
		expect(source.dir).toBe("starter-cloudflare");
	});

	it("treats unknown keys as literal directory passthrough (node)", () => {
		const source = resolveTemplateSource("my-template", "node", env("my-org/emdash-templates"));
		expect(source.dir).toBe("my-template");
	});

	it("treats unknown keys as literal directory passthrough (cloudflare — no suffix)", () => {
		// Ad-hoc dirs are downloaded as-is; the -cloudflare suffix rule only
		// applies to the built-in key list.
		const source = resolveTemplateSource("nested/my-template", "cloudflare", env());
		expect(source.dir).toBe("nested/my-template");
	});

	it("falls back to the default repo for ad-hoc dirs when the env var is absent", () => {
		const source = resolveTemplateSource("my-template", "node", env());
		expect(source.repo).toBe(GITHUB_REPO);
		expect(source.dir).toBe("my-template");
	});

	it("falls back to the default repo when the env var is empty", () => {
		const source = resolveTemplateSource("blog", "node", env(""));
		expect(source.repo).toBe(GITHUB_REPO);
	});

	it("provides a label for the seed config (known name, ad-hoc key)", () => {
		expect(resolveTemplateSource("blog", "node", env()).name).toBe("Blog");
		expect(resolveTemplateSource("my-template", "node", env()).name).toBe("my-template");
	});
});
