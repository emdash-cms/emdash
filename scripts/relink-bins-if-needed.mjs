#!/usr/bin/env node
// Relink workspace bin symlinks after build, but only when needed.
// pnpm only creates bin links when the target file exists at install time.
// Since the CLI lives in dist/, it doesn't exist until after the first build.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// Skip in CI — bins are handled by the CI setup step
if (process.env.CI) process.exit(0);

const CLI_SRC = "packages/core/dist/cli/index.mjs";

// If the built CLI doesn't exist, the build itself failed — nothing to relink
if (!existsSync(CLI_SRC)) process.exit(0);

const binDir = execSync("pnpm bin", { encoding: "utf-8" }).trim();
const cliBin = `${binDir}/emdash`;

// If the bin symlink is missing or broken, relink
if (!existsSync(cliBin)) {
	console.log("CLI bin missing — relinking...");
	execSync("pnpm install --frozen-lockfile", { stdio: "inherit" });
}
