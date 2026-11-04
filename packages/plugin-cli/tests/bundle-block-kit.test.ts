import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bundlePlugin } from "../src/api.js";

/**
 * Regression: sandboxed plugins must be able to import Block Kit server
 * helpers from `@emdash-cms/blocks/server`. Those imports must be bundled
 * (not left external) so the probe build can import the generated output from
 * a fresh temporary directory that does not contain the plugin's
 * node_modules. See issue #3881.
 */
describe("bundlePlugin with @emdash-cms/blocks/server", () => {
	let outDir: string;

	beforeEach(async () => {
		outDir = await mkdtemp(join(tmpdir(), "emdash-blocks-bundle-"));
	});

	afterEach(async () => {
		await rm(outDir, { recursive: true, force: true });
	});

	it("bundles a plugin that imports from @emdash-cms/blocks/server without leaving the import external", async () => {
		const pluginDir = await createBlockKitPluginFixture();
		const originalCwd = process.cwd();

		try {
			// The real CLI runs from inside the plugin directory, so tsdown reads
			// the plugin's package.json to decide which node_modules are external.
			process.chdir(pluginDir);

			const result = await bundlePlugin({
				dir: pluginDir,
				outDir,
				validateOnly: true,
			});

			expect(result.manifest.id).toBe("fixture-block-kit");
			expect(result.manifest.routes).toContain("admin");

			const runtime = await readFile(join(outDir, "plugin.mjs"), "utf-8");
			expect(runtime).not.toMatch(/from\s+["']@emdash-cms\/blocks/);
		} finally {
			process.chdir(originalCwd);
			await rm(pluginDir, { recursive: true, force: true });
		}
	});
});

async function createBlockKitPluginFixture(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "emdash-blocks-plugin-"));
	const srcDir = join(dir, "src");
	const blocksDir = join(dir, "node_modules", "@emdash-cms", "blocks");

	await mkdir(srcDir, { recursive: true });
	await mkdir(blocksDir, { recursive: true });

	await writeFile(
		join(dir, "emdash-plugin.jsonc"),
		JSON.stringify(
			{
				slug: "fixture-block-kit",
				publisher: "fixture.example.com",
				license: "MIT",
				author: { name: "Test Author" },
				security: { email: "security@example.com" },
				capabilities: ["content:read"],
				allowedHosts: ["api.example.com"],
				admin: {
					pages: [{ path: "/home", label: "Home" }],
				},
			},
			null,
			2,
		),
	);

	await writeFile(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: "fixture-block-kit-plugin",
				version: "1.0.0",
				private: true,
				type: "module",
				dependencies: {
					"@emdash-cms/blocks": "*",
				},
			},
			null,
			2,
		),
	);

	await writeFile(
		join(blocksDir, "package.json"),
		JSON.stringify(
			{
				name: "@emdash-cms/blocks",
				version: "1.0.0",
				type: "module",
				exports: {
					".": { default: "./index.js" },
					"./server": { default: "./server.js" },
				},
			},
			null,
			2,
		),
	);

	await writeFile(join(blocksDir, "index.js"), "export {};\n");

	await writeFile(
		join(blocksDir, "server.js"),
		`export const blocks = { header: (text) => ({ type: "header", text }) };\nexport const elements = {};\n`,
	);

	await writeFile(
		join(srcDir, "plugin.ts"),
		`import { blocks, type BlockResponse } from "@emdash-cms/blocks/server";\n\nexport default {\n\troutes: {\n\t\tadmin: async (): Promise<Response> => {\n\t\t\tconst response: BlockResponse = { blocks: [blocks.header("Hello")] };\n\t\t\treturn new Response(JSON.stringify(response), {\n\t\t\t\theaders: { "Content-Type": "application/json" },\n\t\t\t});\n\t\t},\n\t},\n};\n`,
	);

	return dir;
}
