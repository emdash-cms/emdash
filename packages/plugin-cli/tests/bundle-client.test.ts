import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { bundlePlugin } from "../src/api.js";

const execFileAsync = promisify(execFile);

it("bundles emdash/client helpers into an independently executable plugin", async () => {
	const dir = await mkdtemp(join(tmpdir(), "emdash-client-plugin-"));
	const outDir = await mkdtemp(join(tmpdir(), "emdash-client-bundle-"));
	const originalCwd = process.cwd();
	try {
		await mkdir(join(dir, "src"));
		await mkdir(join(dir, "node_modules"));
		// Requires a root `pnpm build` for the real emdash/client artifact.
		await symlink(
			fileURLToPath(new URL("../../core/", import.meta.url)),
			join(dir, "node_modules", "emdash"),
			"dir",
		);
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({
				name: "fixture-client-plugin",
				version: "1.0.0",
				type: "module",
				dependencies: { emdash: "*" },
			}),
		);
		await writeFile(
			join(dir, "emdash-plugin.jsonc"),
			JSON.stringify({
				slug: "fixture-client",
				publisher: "fixture.example.com",
				license: "MIT",
				author: { name: "Test Author" },
				security: { email: "security@example.com" },
			}),
		);
		await writeFile(
			join(dir, "src", "plugin.ts"),
			`
import { portableTextToMarkdown } from "emdash/client";
export default {
	routes: {
		read: async () => new Response(portableTextToMarkdown([
			{ _type: "block", style: "normal", children: [{ _type: "span", text: "Public sample", marks: [] }] },
		])),
	},
};
`,
		);
		// The CLI runs in the plugin project, whose dependencies tsdown externalizes.
		process.chdir(dir);
		const result = await bundlePlugin({ dir, outDir, validateOnly: true });
		expect(result.manifest.routes).toContain("read");
		process.chdir(originalCwd);
		await rm(dir, { recursive: true, force: true });
		const { stdout } = await execFileAsync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"const { default: plugin } = await import(process.argv[1]); process.stdout.write(await (await plugin.routes.read()).text());",
				pathToFileURL(join(outDir, "plugin.mjs")).href,
			],
			{ cwd: outDir },
		);
		expect(stdout.trim()).toBe("Public sample");
	} finally {
		process.chdir(originalCwd);
		await rm(dir, { recursive: true, force: true });
		await rm(outDir, { recursive: true, force: true });
	}
});
