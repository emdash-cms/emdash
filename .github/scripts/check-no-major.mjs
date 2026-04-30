#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";

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
	if (Number.isFinite(major) && major >= 1) {
		offenders.push(`${pkg.name}@${pkg.version} (${file})`);
	}
}

if (offenders.length > 0) {
	console.error("::error::Non-0.x versions detected. Releases must stay in 0.x while in pre-1.0:");
	for (const o of offenders) console.error(`  ${o}`);
	process.exit(1);
}

console.log(`Checked ${seen.length} non-private packages, all are 0.x.`);
