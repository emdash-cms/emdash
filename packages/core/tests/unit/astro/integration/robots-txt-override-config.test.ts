import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroIntegration } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emdash } from "../../../../src/astro/integration/index.js";
import { RESOLVED_VIRTUAL_CONFIG_ID } from "../../../../src/astro/integration/virtual-modules.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runtimeConfigFor(pages: string[]) {
	const projectRoot = await mkdtemp(join(tmpdir(), "emdash-robots-override-"));
	roots.push(projectRoot);
	await mkdir(join(projectRoot, "src/pages"), { recursive: true });
	for (const page of pages) {
		await writeFile(
			join(projectRoot, "src/pages", page),
			"export const GET = () => new Response('');",
		);
	}

	const root = pathToFileURL(`${projectRoot}/`);
	const setup = emdash({}).hooks["astro:config:setup"] as NonNullable<
		AstroIntegration["hooks"]["astro:config:setup"]
	>;
	const updateConfig = vi.fn();
	await setup({
		command: "build",
		config: {
			root,
			srcDir: new URL("src/", root),
			security: {},
			trailingSlash: "ignore",
			integrations: [{ name: "@astrojs/react", hooks: {} }],
		},
		logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig,
	} as never);
	const plugins = updateConfig.mock.calls.flatMap(([update]) => update?.vite?.plugins ?? []);
	const virtualModules = plugins.find(
		(plugin: { name?: string }) => plugin?.name === "emdash-virtual-modules",
	);
	const source = String(virtualModules.load(RESOLVED_VIRTUAL_CONFIG_ID));
	return JSON.parse(source.replace(/^export default /, "").replace(/;$/, "")) as {
		robotsTxtOverridden?: boolean;
	};
}

describe("robotsTxtOverridden in the runtime config", () => {
	it("is true when the site defines src/pages/robots.txt", async () => {
		const config = await runtimeConfigFor(["robots.txt.ts"]);
		expect(config.robotsTxtOverridden).toBe(true);
	});

	it("is false when the site defines other pages only", async () => {
		const config = await runtimeConfigFor(["index.ts"]);
		expect(config.robotsTxtOverridden).toBe(false);
	});
});
