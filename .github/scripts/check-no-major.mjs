#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";

const config = JSON.parse(readFileSync(".changeset/config.json", "utf8"));
const fixedGroup = new Set(config.fixed.flat());

const FRONTMATTER = /^---\n([\s\S]*?)\n---/;
const RELEASE_LINE = /^\s*["']?([^"':]+)["']?\s*:/;

function changesetPackages(file) {
	const frontmatter = readFileSync(`.changeset/${file}`, "utf8").match(FRONTMATTER);
	if (!frontmatter) return [];
	return frontmatter[1]
		.split("\n")
		.map((line) => line.match(RELEASE_LINE)?.[1])
		.filter(Boolean);
}

// The fixed group releases as 1.0.1 because emdash@1.0.0 and several siblings
// exist, deprecated, on npm. 1.0.0 is an unpublished baseline that a patch
// changeset in pre mode turns into 1.0.1-rc.N, then 1.0.1 on exit. It is only
// valid while a fixed-group changeset is pending: otherwise a publish run would
// try to publish 1.0.0 for the fixed-group packages that never had one.
const hasPendingFixedGroupChangeset = readdirSync(".changeset")
	.filter((file) => file.endsWith(".md") && file !== "README.md")
	.some((file) => changesetPackages(file).some((name) => fixedGroup.has(name)));
const ONE_POINT_OH = hasPendingFixedGroupChangeset
	? /^1\.0\.(?:0|1(?:-rc\.\d+)?)$/
	: /^1\.0\.1(?:-rc\.\d+)?$/;

const offenders = [];
const seen = [];

for await (const file of glob("**/package.json", {
	exclude: (path) =>
		path.includes("node_modules") || path.includes("/dist/") || path.includes("/.git/"),
})) {
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		continue;
	}
	if (pkg.private || !pkg.name || !pkg.version) continue;
	seen.push(`${pkg.name}@${pkg.version}`);
	const major = Number.parseInt(pkg.version.split(".")[0], 10);
	if (!Number.isFinite(major) || major < 1) continue;
	if (fixedGroup.has(pkg.name) && ONE_POINT_OH.test(pkg.version)) continue;
	offenders.push(`${pkg.name}@${pkg.version} (${file})`);
}

if (offenders.length > 0) {
	console.error(
		"::error::Unexpected package versions. The fixed group may only be 1.0.1-rc.N or 1.0.1, or 1.0.0 while a fixed-group changeset is pending; every other package must stay 0.x. A minor changeset during the 1.0 release candidate produces 1.1.0-rc.N:",
	);
	for (const o of offenders) console.error(`  ${o}`);
	process.exit(1);
}

console.log(`Checked ${seen.length} non-private packages.`);
