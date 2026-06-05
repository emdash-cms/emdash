// Attach sandboxed-plugin tarballs to the GitHub releases that
// `changesets/action` creates during a release run.
//
// The decentralized plugin registry (RFC 0001) stores only a *link* to the
// plugin bytes, not the bytes themselves. By bundling each published
// sandboxed plugin and uploading the tarball as a release asset, every
// version automatically gets a stable public URL that an `emdash-plugin
// publish --url ...` step (or a human) can point a registry record at.
//
// Input: the `publishedPackages` output from changesets/action, passed via
// the PUBLISHED_PACKAGES env var as a JSON array of `{ name, version }`.
// Only packages under `packages/plugins/*` that expose a `./sandbox` export
// and are not private are processed; everything else (native plugins, test
// fixtures) is skipped.
//
// Set DRY_RUN=1 to bundle and resolve tarballs without calling `gh`.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGINS_DIR = "packages/plugins";
const BUNDLER = "packages/plugin-cli/dist/index.mjs";

const SLASH_RE = /\//g;
const LEADING_AT_RE = /^@/;

const repo = process.env.GITHUB_REPOSITORY;
const dryRun = process.env.DRY_RUN === "1";

const raw = process.env.PUBLISHED_PACKAGES ?? "[]";
let published;
try {
	published = JSON.parse(raw);
} catch (error) {
	console.error(`Could not parse PUBLISHED_PACKAGES as JSON: ${error.message}`);
	process.exit(1);
}

if (!Array.isArray(published) || published.length === 0) {
	console.log("No published packages to process.");
	process.exit(0);
}

// name -> version for the packages that were just published.
const publishedVersions = new Map(published.map((p) => [p.name, p.version]));

/** Slugify a manifest id the same way the bundler names its tarball. */
const slugify = (id) => id.replace(SLASH_RE, "-").replace(LEADING_AT_RE, "");

const failures = [];
let attached = 0;

for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;

	const dir = join(PLUGINS_DIR, entry.name);
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) continue;

	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

	// Only published, public, sandboxed plugins.
	if (!publishedVersions.has(pkg.name)) continue;
	if (pkg.private === true) continue;
	if (!pkg.exports?.["./sandbox"]) {
		console.log(`Skipping ${pkg.name}: no ./sandbox export (not a sandboxed plugin).`);
		continue;
	}

	const version = publishedVersions.get(pkg.name);
	const tag = `${pkg.name}@${version}`;
	console.log(`\n=== ${pkg.name}@${version} ===`);

	try {
		// Bundle. This rebuilds from source and writes dist/<slug>-<version>.tar.gz
		// plus dist/manifest.json, so we can read the exact id/version back out
		// rather than guessing the filename (stale tarballs may linger in dist/).
		execFileSync("node", [BUNDLER, "bundle", "--dir", dir], { stdio: "inherit" });

		const manifest = JSON.parse(readFileSync(join(dir, "dist", "manifest.json"), "utf-8"));
		const tarball = join(dir, "dist", `${slugify(manifest.id)}-${manifest.version}.tar.gz`);
		if (!existsSync(tarball)) {
			throw new Error(`Expected tarball not found: ${tarball}`);
		}

		if (dryRun) {
			console.log(`[dry-run] would upload ${tarball} to release ${tag}`);
		} else {
			// --clobber so re-runs replace the asset instead of failing.
			execFileSync("gh", ["release", "upload", tag, tarball, "--clobber", "--repo", repo], {
				stdio: "inherit",
			});
			console.log(`Attached ${tarball} to ${tag}`);
		}
		attached++;
	} catch (error) {
		console.error(`Failed to attach tarball for ${pkg.name}: ${error.message}`);
		failures.push(pkg.name);
	}
}

console.log(`\nAttached ${attached} plugin tarball(s).`);
if (failures.length > 0) {
	console.error(`Failed: ${failures.join(", ")}`);
	process.exit(1);
}
