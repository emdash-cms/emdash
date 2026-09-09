import { expect, it } from "vitest";

import { extractManifestRoute } from "../src/routes.js";

it("extracts metadata from a bare route handler", () => {
	expect(extractManifestRoute("legacy", async () => ({ ok: true }))).toBe("legacy");
});
