import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroConfig } from "astro";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAdminLocaleManifest } from "../../../src/astro/integration/admin-locales.js";
import { createViteConfig, resolveAdminDist } from "../../../src/astro/integration/vite-config.js";

interface BuiltLocales {
	SUPPORTED_LOCALES: { code: string }[];
	loadMessages: (locale: string) => Promise<Record<string, unknown>>;
}

const adminDistPath = resolveAdminDist();
const manifest = readAdminLocaleManifest(adminDistPath);
const catalogLocaleByPath = new Map(
	Object.entries(manifest).map(([code, chunk]) => [resolve(adminDistPath, chunk), code]),
);

let workDir: string;
let bundledCatalogs: string[];
let built: BuiltLocales;

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "emdash-admin-locales-build-"));
	const entry = join(workDir, "entry.js");
	writeFileSync(
		entry,
		`export { SUPPORTED_LOCALES, loadMessages } from "@emdash-cms/admin/locales";\n`,
	);

	// The project root must resolve `react`, which the admin dedupes.
	const projectRoot = resolve(import.meta.dirname, "../../..");
	const viteConfig = createViteConfig(
		{
			serializableConfig: {},
			resolvedConfig: { admin: { locales: ["en", "de"] } },
			pluginDescriptors: [],
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- createViteConfig reads only these fields.
			astroConfig: {
				root: pathToFileURL(`${projectRoot}/`),
				adapter: { name: "@astrojs/node" },
			} as AstroConfig,
		},
		"build",
	);

	const output = await build({
		configFile: false,
		logLevel: "silent",
		root: projectRoot,
		define: viteConfig.define,
		resolve: viteConfig.resolve,
		plugins: viteConfig.plugins,
		build: {
			outDir: join(workDir, "dist"),
			minify: false,
			lib: { entry, formats: ["es"], fileName: "entry" },
		},
	});

	const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) =>
		"output" in result ? result.output : [],
	);
	bundledCatalogs = chunks
		.flatMap((chunk) => (chunk.type === "chunk" ? Object.keys(chunk.modules) : []))
		.flatMap((id) => catalogLocaleByPath.get(id) ?? [])
		.toSorted();

	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the entry re-exports these from the admin locales barrel.
	built = (await import(pathToFileURL(join(workDir, "dist", "entry.js")).href)) as BuiltLocales;
}, 60_000);

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("admin.locales in a Vite build", () => {
	it("bundles only the catalogs of the listed locales", () => {
		expect(bundledCatalogs).toEqual(["de", "en"]);
	});

	it("offers only the listed locales", () => {
		expect(built.SUPPORTED_LOCALES.map((locale) => locale.code)).toEqual(["en", "de"]);
	});

	it("serves the English catalog for an unlisted locale", async () => {
		const english = await built.loadMessages("en");
		expect(await built.loadMessages("fr")).toEqual(english);
		expect(await built.loadMessages("de")).not.toEqual(english);
	});
});
