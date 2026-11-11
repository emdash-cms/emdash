import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "vite";
import { expect, it } from "vitest";

import { emdashPluginTest } from "../../src/config.js";

it("resolves the test host dialect outside a project with a direct Cloudflare dependency", async () => {
	const root = await mkdtemp(join(tmpdir(), "plugin-test-consumer-"));
	const cwd = process.cwd();
	try {
		process.chdir(root);
		const entry = join(root, "entry.js");
		await writeFile(
			entry,
			'export { createDialect, createRequestScopedDb } from "virtual:emdash/dialect";',
		);
		const plugins = emdashPluginTest({ dir: root });
		if (!Array.isArray(plugins)) throw new Error("Expected test host plugins");
		const result = await build({
			root,
			configFile: false,
			logLevel: "silent",
			plugins: [plugins[0]],
			build: {
				write: false,
				lib: { entry, formats: ["es"] },
				rolldownOptions: {
					external: (id) =>
						id === "cloudflare:workers" ||
						id === "kysely" ||
						id === "emdash" ||
						id.startsWith("emdash/"),
				},
			},
		});
		const bundles = Array.isArray(result) ? result : [result];
		const chunks = bundles.flatMap((bundle) =>
			"output" in bundle ? bundle.output.filter((chunk) => chunk.type === "chunk") : [],
		);
		expect(chunks.flatMap((chunk) => chunk.exports)).toEqual(
			expect.arrayContaining(["createDialect", "createRequestScopedDb"]),
		);
	} finally {
		process.chdir(cwd);
		await rm(root, { recursive: true, force: true });
	}
});
