import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { PluginDescriptor } from "../../../src/astro/integration/runtime.js";
import { generateSandboxedPluginsModule } from "../../../src/astro/integration/virtual-modules.js";

function descriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
	return {
		id: "test-plugin",
		version: "1.0.0",
		entrypoint: "@test/plugin/sandbox",
		format: "standard",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		adminPages: [],
		adminWidgets: [],
		...overrides,
	};
}

describe("generateSandboxedPluginsModule", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "emdash-vm-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	async function setupFakeProject(exportPath: string, content: string) {
		// Create a fake project root with package.json
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ name: "test-project" }));

		// Create the plugin package inside node_modules
		const pluginDir = join(tmpDir, "node_modules", "@test", "plugin");
		await mkdir(pluginDir, { recursive: true });

		// Determine the directory for the export file
		const fileParts = exportPath.split("/");
		if (fileParts.length > 1) {
			const dir = join(pluginDir, ...fileParts.slice(0, -1));
			await mkdir(dir, { recursive: true });
		}

		await writeFile(join(pluginDir, exportPath), content);
		await writeFile(
			join(pluginDir, "package.json"),
			JSON.stringify({
				name: "@test/plugin",
				exports: { "./sandbox": `./${exportPath}` },
			}),
		);
	}

	it("returns empty module when no plugins configured", () => {
		const result = generateSandboxedPluginsModule([], tmpDir);
		expect(result).toContain("export const sandboxedPlugins = []");
	});

	it("embeds pre-built JavaScript successfully", async () => {
		await setupFakeProject("dist/sandbox-entry.mjs", "export default { hooks: {} };");

		const result = generateSandboxedPluginsModule(
			[descriptor({ entrypoint: "@test/plugin/sandbox" })],
			tmpDir,
		);

		expect(result).toContain("sandboxedPlugins");
		expect(result).toContain("test-plugin");
		expect(result).toContain("export default { hooks: {} };");
	});

	it("throws for .ts source files", async () => {
		await setupFakeProject("src/sandbox-entry.ts", "export default {};");

		expect(() =>
			generateSandboxedPluginsModule([descriptor({ entrypoint: "@test/plugin/sandbox" })], tmpDir),
		).toThrow(/unbuilt source/);
	});

	it("throws for .tsx source files", async () => {
		await setupFakeProject("src/sandbox-entry.tsx", "export default {};");

		expect(() =>
			generateSandboxedPluginsModule([descriptor({ entrypoint: "@test/plugin/sandbox" })], tmpDir),
		).toThrow(/unbuilt source/);
	});

	it("throws for .mts source files", async () => {
		await setupFakeProject("src/sandbox-entry.mts", "export default {};");

		expect(() =>
			generateSandboxedPluginsModule([descriptor({ entrypoint: "@test/plugin/sandbox" })], tmpDir),
		).toThrow(/unbuilt source/);
	});

	it("includes plugin id in error message", async () => {
		await setupFakeProject("src/sandbox-entry.ts", "export default {};");

		expect(() =>
			generateSandboxedPluginsModule(
				[descriptor({ id: "my-broken-plugin", entrypoint: "@test/plugin/sandbox" })],
				tmpDir,
			),
		).toThrow(/my-broken-plugin/);
	});
});
