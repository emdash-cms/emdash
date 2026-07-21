import { readFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve("dist/emdash_bot");
const config = JSON.parse(await readFile(path.join(outputDirectory, "wrangler.json"), "utf8"));
const worker = await readFile(path.join(outputDirectory, config.main), "utf8");
const exports = new Set();

for (const match of worker.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
	for (const entry of match[1].split(",")) {
		const exportedName = entry
			.trim()
			.split(/\s+as\s+/)
			.at(-1);
		if (exportedName) exports.add(exportedName);
	}
}

const missing = (config.durable_objects?.bindings ?? [])
	.filter((binding) => !binding.script_name && !binding.environment)
	.map((binding) => binding.class_name)
	.filter((className) => !exports.has(className));

if (missing.length > 0) {
	throw new Error(`Worker bundle is missing Durable Object exports: ${missing.join(", ")}`);
}
