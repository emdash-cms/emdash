#!/usr/bin/env node
/**
 * Regenerates every committed `emdash-env.d.ts` in the repo.
 *
 * Each project's file is rebuilt the way a fresh `astro dev` run would write
 * it: migrate an empty database, apply the project's seed, and generate types
 * from the resulting schema. CI runs this on pull requests and pushes any
 * drift back to the branch (see .github/workflows/env-types*.yml).
 *
 * Usage:
 *   node scripts/env-types.mjs
 *
 * Prerequisite: `pnpm build` has run (the generator is loaded from dist/).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");
const generatorPath = resolve(repoRoot, "packages/core/dist/schema/project-env-types.mjs");

const projectRoot = process.argv[2];

if (projectRoot) {
	// Child mode: one project per process, so schema caches held on
	// globalThis never leak between projects.
	const { generateProjectEnvTypes } = await import(pathToFileURL(generatorPath).href);
	const types = await generateProjectEnvTypes(projectRoot);
	const outputPath = resolve(projectRoot, "emdash-env.d.ts");
	const current = readFileSync(outputPath, "utf-8");
	if (current !== types) {
		writeFileSync(outputPath, types, "utf-8");
		console.log(`updated  ${outputPath}`);
	}
} else {
	const files = execFileSync("git", ["ls-files", "--", "*emdash-env.d.ts", "emdash-env.d.ts"], {
		cwd: repoRoot,
		encoding: "utf-8",
	})
		.split("\n")
		.filter(Boolean);

	if (files.length === 0) {
		console.error("No committed emdash-env.d.ts files found.");
		process.exit(1);
	}

	let failed = false;
	for (const file of files) {
		const result = spawnSync(process.execPath, [__filename, resolve(repoRoot, dirname(file))], {
			cwd: repoRoot,
			stdio: "inherit",
		});
		if (result.status !== 0) {
			console.error(`failed   ${file}`);
			failed = true;
		}
	}
	console.log(`Checked ${files.length} emdash-env.d.ts files.`);
	if (failed) process.exit(1);
}
