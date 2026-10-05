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
});
