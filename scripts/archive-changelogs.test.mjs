import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { archiveChangelogs, splitChangelog } from "./archive-changelogs.mjs";

function release(version, size = 40) {
	return `## ${version}\n\n### Patch Changes\n\n- ${"x".repeat(size)}\n`;
}

void test("moves whole release sections into a chained archive", () => {
	const source = `# package\n\n${release("1.3.0")}${release("1.2.0")}${release("1.1.0")}${release("1.0.0")}`;
	const result = splitChangelog(source, 180);

	assert.ok(result.active.includes("## 1.3.0"));
	assert.ok(!result.active.includes("## 1.0.0"));
	assert.ok(result.active.includes("emdash-changelog-archive: ./changelog/"));
	assert.ok(result.archives.length > 0);
	assert.ok(result.archives.at(-1).content.includes("## 1.0.0"));
	assert.ok(
		!result.archives
			.map(({ content }) => content)
			.join("\n")
			.includes("## 1.3.0"),
	);
});

void test("preserves the previous archive chain when the active file rotates again", () => {
	const source = `# package\n\n<!-- emdash-changelog-archive: ./changelog/0.1.0-to-0.9.0.md -->\n\n${release("1.2.0", 100)}${release("1.1.0", 100)}${release("1.0.0", 100)}`;
	const result = splitChangelog(source, 220);

	assert.ok(
		result.archives.at(-1).content.includes("emdash-changelog-archive: ./0.1.0-to-0.9.0.md"),
	);
});

void test("leaves a changelog alone when it is below the bound", () => {
	const source = `# package\n\n${release("1.0.0")}`;
	assert.deepEqual(splitChangelog(source, 1024), { active: source, archives: [] });
});

await test("archives changelogs in nested package directories", async () => {
	const root = await mkdtemp(resolve(tmpdir(), "emdash-changelog-"));
	try {
		const packageDirectory = resolve(root, "packages/plugins/example");
		await mkdir(packageDirectory, { recursive: true });
		await writeFile(resolve(packageDirectory, "package.json"), '{"name":"example"}\n');
		await writeFile(
			resolve(packageDirectory, "CHANGELOG.md"),
			`# example\n\n${release("1.2.0", 70_000)}${release("1.1.0", 70_000)}${release("1.0.0", 70_000)}`,
		);

		assert.deepEqual(await archiveChangelogs(root), ["packages/plugins/example/CHANGELOG.md"]);
		assert.ok(
			(await readFile(resolve(packageDirectory, "CHANGELOG.md"), "utf8")).includes(
				"emdash-changelog-archive",
			),
		);
	} finally {
		await rm(root, { recursive: true });
	}
});
