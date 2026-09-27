#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";

// The fixed group releases as 1.0.1 because the deprecated 1.0.0 on npm can
// never be published again. 1.0.0 is the unpublished baseline that a patch
// changeset in pre mode turns into 1.0.1-rc.N, then 1.0.1 on exit.
const ONE_POINT_OH = /^1\.0\.(?:0|1(?:-rc\.\d+)?)$/;

const config = JSON.parse(readFileSync(".changeset/config.json", "utf8"));
const fixedGroup = new Set(config.fixed.flat());

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
		"::error::Unexpected package versions. The fixed group may only be 1.0.0, 1.0.1-rc.N or 1.0.1; every other package must stay 0.x. A minor changeset during the 1.0 release candidate produces 1.1.0-rc.N:",
	);
	for (const o of offenders) console.error(`  ${o}`);
	process.exit(1);
}

console.log(`Checked ${seen.length} non-private packages.`);
