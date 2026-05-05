#!/usr/bin/env node
/**
 * Copy the source lexicon JSON files from the repo root into this package
 * so they ship with the published artifact.
 *
 * The lexicons live at the repo root (currently authored on the
 * `wip/plugin-rfc` branch). On branches without the root `lexicons/` directory
 * — e.g. `main` before the RFC merges — we fall back to the copy already
 * checked into `packages/registry-lexicons/lexicons/`. That keeps the package
 * buildable on any branch without forcing every contributor to rebase the RFC
 * branch in.
 */
import { access, cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const src = resolve(repoRoot, "lexicons", "com", "emdashcms", "experimental");
const dst = resolve(pkgRoot, "lexicons", "com", "emdashcms", "experimental");

let sourceAvailable = true;
try {
	await access(src);
} catch {
	sourceAvailable = false;
}

if (sourceAvailable) {
	await rm(resolve(pkgRoot, "lexicons"), { recursive: true, force: true });
	await mkdir(dirname(dst), { recursive: true });
	await cp(src, dst, { recursive: true });
	console.log(`copied lexicons from ${src} -> ${dst}`);
} else {
	// No repo-root lexicons on this branch — leave the in-package copy alone.
	let inPackageAvailable = true;
	try {
		await access(dst);
	} catch {
		inPackageAvailable = false;
	}
	if (!inPackageAvailable) {
		console.error(
			`no lexicons found at ${src} and no in-package copy at ${dst}; check out the RFC branch or commit a copy under packages/registry-lexicons/lexicons/.`,
		);
		process.exit(1);
	}
	console.log(`using in-package lexicon copy at ${dst} (no source at ${src})`);
}
