import { describe, expect, it } from "vitest";

import { applyCatalogEdits, catalogEntry, catalogName } from "../src/catalog.js";

const WORKSPACE = `packages:
  - sites/*

# Shared EmDash versions
catalog:
  emdash: ^1.0.0 # keep in step with the cloudflare adapter
  "@emdash-cms/cloudflare": "~1.0.0"

catalogs:
  default-extra:
    astro: ^7.0.0
  preview:
    emdash: 1.1.0-rc.0
`;

describe("pnpm catalogs", () => {
	it("names the catalog a specifier refers to", () => {
		expect(catalogName("catalog:")).toBe("default");
		expect(catalogName("catalog:default")).toBe("default");
		expect(catalogName("catalog:preview")).toBe("preview");
		expect(catalogName("^1.0.0")).toBeNull();
	});

	it("finds entries in the default and named catalogs", () => {
		expect(catalogEntry(WORKSPACE, "default", "emdash")).toBe("^1.0.0");
		expect(catalogEntry(WORKSPACE, "default", "@emdash-cms/cloudflare")).toBe("~1.0.0");
		expect(catalogEntry(WORKSPACE, "preview", "emdash")).toBe("1.1.0-rc.0");
		expect(catalogEntry(WORKSPACE, "preview", "@emdash-cms/cloudflare")).toBeUndefined();
		expect(catalogEntry("catalogs:\n  default:\n    emdash: ^1.0.0\n", "default", "emdash")).toBe(
			"^1.0.0",
		);
	});

	it("updates catalog entries without disturbing comments, quoting, or other entries", () => {
		const updated = applyCatalogEdits(WORKSPACE, [
			{ catalog: "default", packageName: "emdash", specifier: "^1.1.0" },
			{ catalog: "default", packageName: "@emdash-cms/cloudflare", specifier: "~1.1.0" },
			{ catalog: "preview", packageName: "emdash", specifier: "1.2.0-rc.0" },
		]);

		expect(updated).toBe(
			WORKSPACE.replace("emdash: ^1.0.0 #", "emdash: ^1.1.0 #")
				.replace('"~1.0.0"', '"~1.1.0"')
				.replace("emdash: 1.1.0-rc.0", "emdash: 1.2.0-rc.0"),
		);
	});

	it("changes only the edited values in files with other indentation and line endings", () => {
		for (const source of [
			"catalog:\n    emdash: ^1.0.0  # two spaces before the comment\n    astro: ^7.0.0\n",
			"catalog:\r\n  emdash: ^1.0.0 # windows line endings\r\n",
			"---\ncatalog:\n  emdash: '^1.0.0'\n# trailing comment\n",
			'catalog: { emdash: "^1.0.0", astro: ^7.0.0 }\n',
		]) {
			expect(
				applyCatalogEdits(source, [
					{ catalog: "default", packageName: "emdash", specifier: "^1.1.0" },
				]),
			).toBe(source.replace("^1.0.0", "^1.1.0"));
		}
	});
});
