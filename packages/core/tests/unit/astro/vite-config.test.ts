import { basename } from "node:path";

import type { AstroConfig } from "astro";
import { describe, expect, it } from "vitest";

import { createViteConfig } from "../../../src/astro/integration/vite-config.js";

describe("createViteConfig admin aliasing", () => {
	const monorepoDemoRoot = new URL("../../../../../demos/simple/", import.meta.url);
	const externalProjectRoot = new URL("file:///workspace/emdash-site/");
	const siblingProjectRoot = new URL("../../../../../../emdash-site/", import.meta.url);
	const adminSourcePattern = /[/\\]packages[/\\]admin[/\\]src$/;
	const adminDistPattern = /[/\\]packages[/\\]admin[/\\]dist$/;

	function buildConfig(root: URL, command: "dev" | "build" | "preview" | "sync" = "dev") {
		return createViteConfig(
			{
				serializableConfig: {},
				resolvedConfig: {} as never,
				pluginDescriptors: [],
				astroConfig: {
					root,
					adapter: { name: "@astrojs/node" },
				} as AstroConfig,
			},
			command,
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

	it("uses raw admin source for local monorepo dev", () => {
		const config = buildConfig(monorepoDemoRoot);
		const replacement = getAdminAliasReplacement(config);

		expect(basename(replacement)).toBe("src");
		expect(replacement).toMatch(adminSourcePattern);
	});

	it("uses built admin dist for external app dev", () => {
		const config = buildConfig(externalProjectRoot);
		const replacement = getAdminAliasReplacement(config);

		expect(basename(replacement)).toBe("dist");
		expect(replacement).toMatch(adminDistPattern);
	});

	it("uses built admin dist for sibling paths with a matching prefix", () => {
		const config = buildConfig(siblingProjectRoot);
		const replacement = getAdminAliasReplacement(config);

		expect(basename(replacement)).toBe("dist");
		expect(replacement).toMatch(adminDistPattern);
	});

	it("uses built admin dist outside dev", () => {
		const config = buildConfig(monorepoDemoRoot, "build");
		const replacement = getAdminAliasReplacement(config);

		expect(basename(replacement)).toBe("dist");
		expect(replacement).toMatch(adminDistPattern);
	});
});
