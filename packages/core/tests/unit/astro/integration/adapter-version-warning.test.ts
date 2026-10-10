import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adapterVersionMismatchWarning } from "../../../../src/astro/integration/index.js";

describe("adapterVersionMismatchWarning", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "emdash-adapter-version-"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "site" }));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function installAdapter(version: string, packageJson = JSON.stringify({ version })) {
		const dir = join(root, "node_modules", "@emdash-cms", "cloudflare");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), packageJson);
	}

	const rootUrl = () => pathToFileURL(`${root}/`);

	it("warns with both versions when the adapter differs from emdash", () => {
		installAdapter("1.0.1");
		const warning = adapterVersionMismatchWarning(rootUrl(), "1.1.0");
		expect(warning).toContain("@emdash-cms/cloudflare 1.0.1");
		expect(warning).toContain("emdash 1.1.0");
		expect(warning).toContain("emdash@1.1.0 @emdash-cms/cloudflare@1.1.0");
	});

	it("finds an adapter hoisted to a parent directory", () => {
		installAdapter("1.0.1");
		const site = join(root, "apps", "site");
		mkdirSync(site, { recursive: true });
		expect(adapterVersionMismatchWarning(pathToFileURL(`${site}/`), "1.1.0")).toContain(
			"@emdash-cms/cloudflare 1.0.1",
		);
	});

	it("stays quiet when the adapter's package.json is unreadable", () => {
		installAdapter("1.0.1", "{ truncated");
		expect(adapterVersionMismatchWarning(rootUrl(), "1.1.0")).toBeUndefined();
	});

	it("stays quiet when the versions match", () => {
		installAdapter("1.1.0");
		expect(adapterVersionMismatchWarning(rootUrl(), "1.1.0")).toBeUndefined();
	});

	it("stays quiet when the adapter is not installed", () => {
		expect(adapterVersionMismatchWarning(rootUrl(), "1.1.0")).toBeUndefined();
	});
});
