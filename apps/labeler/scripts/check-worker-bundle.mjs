import { readFile } from "node:fs/promises";

const bundle = await readFile(new URL("../dist/emdash_labeler/index.js", import.meta.url), "utf8");
for (const forbidden of ["createRequire(", 'from "node:module"', "from 'node:module'"]) {
	if (bundle.includes(forbidden)) {
		throw new Error(`Labeler Worker bundle contains Node-only module loading: ${forbidden}`);
	}
}
