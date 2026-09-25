import { fileURLToPath } from "node:url";

import type { AstroConfig } from "astro";
import { build, type PluginOption } from "vite";
import { describe, expect, it } from "vitest";

import { createViteConfig } from "../../../../src/astro/integration/vite-config.js";

const ENTRY_ID = "virtual:workers-builtins-entry";
const RESOLVED_ENTRY_ID = `\0${ENTRY_ID}`;
const ARTIFACT_FETCH_PATH = fileURLToPath(
	new URL("../../../../src/registry/artifact-fetch.ts", import.meta.url),
);
const WORKERS_SOCKETS_IMPORT = /import\(\s*["']cloudflare:sockets["']\s*\)/;

function nodeAdapterPlugins(): PluginOption[] {
	const config = createViteConfig(
		{
			serializableConfig: {},
			resolvedConfig: {} as never,
			pluginDescriptors: [],
			astroConfig: {
				root: new URL("file:///workspace/emdash-site/"),
				adapter: { name: "@astrojs/node" },
			} as AstroConfig,
		},
		"build",
	);
	// createViteConfig is typed against Astro's Vite; this build runs core's Rollup-based Vite.
	return (config.plugins ?? []) as PluginOption[];
}

async function buildEntry(source: string, target: "server" | "client"): Promise<string> {
	const output = await build({
		configFile: false,
		logLevel: "silent",
		plugins: [
			{
				name: "workers-builtins-test-entry",
				resolveId(id) {
					return id === ENTRY_ID ? RESOLVED_ENTRY_ID : undefined;
				},
				load(id) {
					return id === RESOLVED_ENTRY_ID ? source : undefined;
				},
			},
			...nodeAdapterPlugins(),
		],
		build: {
			write: false,
			ssr: target === "server",
			rollupOptions: { input: ENTRY_ID },
		},
	});
	if ("on" in output) throw new Error("Expected a completed Vite build");
	const builds = Array.isArray(output) ? output : [output];
	return builds
		.flatMap((result) => result.output)
		.map((item) => (item.type === "chunk" ? item.code : ""))
		.join("\n");
}

describe("Node adapter builds with Workers built-ins", () => {
	it("bundles core's artifact fetch and keeps its Workers socket import for the runtime", async () => {
		const code = await buildEntry(
			`export { fetchRegistryArtifactUrl } from ${JSON.stringify(ARTIFACT_FETCH_PATH)};`,
			"server",
		);

		expect(code).toMatch(WORKERS_SOCKETS_IMPORT);
	});

	it("still fails a server build that imports another Workers built-in", async () => {
		await expect(
			buildEntry(`export const load = () => import("cloudflare:workers");`, "server"),
		).rejects.toThrow('failed to resolve import "cloudflare:workers"');
	});

	it("still fails a client build that imports the Workers socket built-in", async () => {
		await expect(
			buildEntry(`export const load = () => import("cloudflare:sockets");`, "client"),
		).rejects.toThrow('failed to resolve import "cloudflare:sockets"');
	});
});
