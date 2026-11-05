import { rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { build } from "tsdown";

import { CHILDREN_DIR } from "./helpers.js";

const PACKAGE_DIR = resolvePath(import.meta.dirname, "../..");

/** Bundles the child-process scripts from source, so they run on every supported Node.js. */
export default async function bundleChildren(): Promise<void> {
	rmSync(CHILDREN_DIR, { recursive: true, force: true });
	await build({
		config: false,
		cwd: PACKAGE_DIR,
		entry: {
			signals: "tests/hosts/children/signals.ts",
			"server-wait": "tests/hosts/children/server-wait.ts",
		},
		outDir: CHILDREN_DIR,
		format: "esm",
		platform: "node",
		dts: false,
		sourcemap: false,
		external: [/^virtual:/],
		logLevel: "warn",
	});
}
