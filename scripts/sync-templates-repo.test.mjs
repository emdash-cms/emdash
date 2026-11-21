import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

void test("sync includes the license in the repository and standalone templates", () => {
	const target = mkdtempSync(join(tmpdir(), "emdash-templates-license-"));
	try {
		execFileSync("git", ["init", target], { stdio: "pipe" });
		const license = readFileSync(join(root, "LICENSE"), "utf8");
		const templates = [
			"blog",
			"blog-cloudflare",
			"marketing",
			"marketing-cloudflare",
			"portfolio",
			"portfolio-cloudflare",
			"starter",
			"starter-cloudflare",
		];

		// Repeat the sync to exercise cleanup of generated template files.
		for (let run = 0; run < 2; run++) {
			execFileSync(
				process.execPath,
				[join(root, "scripts/sync-templates-repo.mjs"), "--local", target, "--dry-run"],
				{ stdio: "pipe" },
			);
			assert.equal(readFileSync(join(target, "LICENSE"), "utf8"), license);
			for (const template of templates) {
				assert.equal(readFileSync(join(target, template, "LICENSE"), "utf8"), license);
			}
		}
	} finally {
		rmSync(target, { recursive: true, force: true });
	}
});
