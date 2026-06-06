#!/usr/bin/env node
/**
 * Identify queries that fire on cold but not warm in the d1 target —
 * the cold-isolate startup tax.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = resolve(__dirname, "d1");

function normalize(sql) {
	return sql.replace(/\s+/g, " ").trim();
}

const routeOrder = [
	"root",
	"posts",
	"posts_building_for_the_long_term",
	"pages_about",
	"category_development",
	"tag_webdev",
	"rss_xml",
	"search",
];

const coldOnlyAcc = new Map(); // sql -> count

for (const r of routeOrder) {
	const coldFile = resolve(dir, `${r}.cold.json`);
	const warmFile = resolve(dir, `${r}.warm.json`);
	const cold = JSON.parse(readFileSync(coldFile, "utf8"));
	const warm = JSON.parse(readFileSync(warmFile, "utf8"));
	const warmSet = new Map();
	for (const e of warm) warmSet.set(normalize(e.sql), (warmSet.get(normalize(e.sql)) || 0) + 1);
	for (const e of cold) {
		const n = normalize(e.sql);
		const wcount = warmSet.get(n) || 0;
		if (wcount > 0) {
			warmSet.set(n, wcount - 1);
		} else {
			coldOnlyAcc.set(n, (coldOnlyAcc.get(n) || 0) + 1);
		}
	}
}

const sorted = [...coldOnlyAcc.entries()].sort((a, b) => b[1] - a[1]);
process.stdout.write(
	`# Cold-only queries (d1)\n\nQueries that appear in cold-phase dumps but not in matching warm-phase dumps. Aggregated across all routes.\n\n`,
);
process.stdout.write(`| count | sql |\n|---:|---|\n`);
for (const [sql, count] of sorted) {
	process.stdout.write(`| ${count} | ${sql.slice(0, 200)} |\n`);
}
