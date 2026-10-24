#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";

const config = JSON.parse(readFileSync(".changeset/config.json", "utf8"));
const fixedGroup = new Set(config.fixed.flat());

// emdash@1.0.0 and several fixed-group siblings exist on npm, deprecated,
// from an accidental release, so 1.0.0 can never be published.
const BURNED_VERSION = "1.0.0";

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
	const allowedMajor = fixedGroup.has(pkg.name) ? 1 : 0;
	if (major !== allowedMajor || pkg.version === BURNED_VERSION) {
		offenders.push(`${pkg.name}@${pkg.version} (${file})`);
	}
}

if (offenders.length > 0) {
	console.error(
		"::error::Unexpected package versions. The fixed group must stay on 1.x (never 1.0.0) and every other package on 0.x. A new major needs a deliberate change to this check:",
	);
	for (const o of offenders) console.error(`  ${o}`);
	process.exit(1);
}

console.log(`Checked ${seen.length} non-private packages.`);
