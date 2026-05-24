#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, "..", "fixtures/perf-site");

const r = spawnSync("pnpm", ["exec", "astro", "build"], {
	cwd: fixtureDir,
	stdio: "inherit",
	env: { ...process.env, EMDASH_FIXTURE_TARGET: "d1" },
});
if (r.status !== 0) process.exit(r.status ?? 1);
writeFileSync(resolve(fixtureDir, "dist/.perf-target"), "d1\n");
