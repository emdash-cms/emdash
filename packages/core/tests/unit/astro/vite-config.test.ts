import { basename } from "node:path";

import type { AstroConfig } from "astro";
import { afterEach, describe, expect, it } from "vitest";

import {
	createViteConfig,
	NODE_NATIVE_EXTERNALS,
	NODE_SSR_EXTERNALS,
} from "../../../src/astro/integration/vite-config.js";

describe("vite-config SSR externals", () => {
	it("extends native externals with the sanitize-html parser stack for Node SSR", () => {
		expect(NODE_SSR_EXTERNALS).toEqual(
			expect.arrayContaining([
				...NODE_NATIVE_EXTERNALS,
				"sanitize-html",
				"htmlparser2",
				"entities",
			]),
		);
	});

	it("does not mutate the native externals list", () => {
		expect(NODE_NATIVE_EXTERNALS).not.toEqual(
			expect.arrayContaining(["sanitize-html", "htmlparser2", "entities"]),
		);
	});
});

describe("createViteConfig admin aliasing", () => {
	const previousUseAdminSource = process.env.EMDASH_USE_ADMIN_SOURCE;

	afterEach(() => {
		if (previousUseAdminSource === undefined) {
			delete process.env.EMDASH_USE_ADMIN_SOURCE;
			return;
		}

		process.env.EMDASH_USE_ADMIN_SOURCE = previousUseAdminSource;
	});

	function buildConfig(adapterName = "@astrojs/node") {
		return createViteConfig(
			{
				serializableConfig: {},
				resolvedConfig: {} as never,
				pluginDescriptors: [],
				astroConfig: {
					root: new URL("file:///workspace/emdash-test/"),
					adapter: { name: adapterName },
				} as AstroConfig,
			},
			"dev",
		);
	}

	function getAdminAliasReplacement(config: ReturnType<typeof createViteConfig>) {
		const aliases = Array.isArray(config.resolve?.alias) ? config.resolve.alias : [];
		const adminAlias = aliases.find(
			(alias) =>
				typeof alias === "object" &&
				alias !== null &&
				"find" in alias &&
				alias.find === "@emdash-cms/admin" &&
				"replacement" in alias,
		);

		if (!adminAlias || typeof adminAlias.replacement !== "string") {
			throw new Error("Missing @emdash-cms/admin alias");
		}

		return adminAlias.replacement;
	}

	it("uses the built admin dist by default in dev", () => {
		delete process.env.EMDASH_USE_ADMIN_SOURCE;

		const config = buildConfig();
		expect(basename(getAdminAliasReplacement(config))).toBe("dist");
	});

	it("only uses raw admin source when explicitly opted in", () => {
		process.env.EMDASH_USE_ADMIN_SOURCE = "1";

		const config = buildConfig();
		expect(basename(getAdminAliasReplacement(config))).toBe("src");
	});

	it("wires node SSR externals into the node config", () => {
		const config = buildConfig();

		expect(config.ssr).toMatchObject({
			external: NODE_SSR_EXTERNALS,
			noExternal: ["emdash", "@emdash-cms/admin"],
		});
		expect(config.optimizeDeps?.exclude).toEqual([...NODE_SSR_EXTERNALS, "virtual:emdash"]);
	});

	it("does not apply node SSR externals in the cloudflare config", () => {
		const config = buildConfig("@astrojs/cloudflare");

		expect(config.ssr).not.toHaveProperty("external");
		expect(config.optimizeDeps?.exclude).toEqual(["virtual:emdash"]);
	});
});
