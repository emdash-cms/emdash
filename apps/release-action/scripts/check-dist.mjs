import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "emdash-action-dist-"));
try {
	await copyFile(new URL("../dist/index.js", import.meta.url), join(directory, "index.js"));
	await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
	await writeFile(join(directory, "release.json"), "{}");
	const result = spawnSync(process.execPath, [join(directory, "index.js")], {
		cwd: directory,
		encoding: "utf8",
		timeout: 30_000,
		env: {
			GITHUB_WORKSPACE: directory,
			"INPUT_SERVICE-URL": "https://release.example.com",
			"INPUT_PUBLISHER-DID": "did:web:publisher.example.com",
			"INPUT_RELEASE-FILE": "release.json",
		},
	});
	assert.ifError(result.error);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stderr.trim(), "::error::Release record file is invalid");
	console.log("Standalone release Action startup check passed.");
} finally {
	await rm(directory, { recursive: true, force: true });
}
